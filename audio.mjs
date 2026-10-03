#!/usr/bin/env node
/**
 * audio.mjs —— 短片《代码动画》配乐合成器（纯 Node.js，零依赖，ESM）
 *
 * 规格：
 *   · 44100 Hz / 立体声 / 16bit PCM / 24.000 秒（每声道 1,058,400 帧）
 *   · 120 BPM：1 拍 = 0.5 s = 15 帧（30 fps），1 小节 = 2.0 s，全片恰好 12 小节
 *   · A 小调；每 2 拍（半小节）换一个和弦，进行为 Am - F - C - G 循环
 *   · 四个段落严格落在 6.0 / 13.0 / 19.0 / 24.0 s（画面剪辑点）
 *   · 完全确定性：只用 mulberry32 种子随机数；不用 Math.random、不读时钟
 *
 * 结构：
 *   0 常量 → 1 随机数/噪声 → 2 基础工具（振荡器/包络/滤波器/总线）
 *   → 3 乐器 → 4 编曲 → 5 母带 → 6 WAV 编码与输出
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`NAME
  audio.mjs — 短片配乐合成器（纯 Node，零依赖）：算出 PCM 直接写 WAV

USAGE
  node scripts/audio.mjs

OUTPUT
  out/track.wav（相对运行目录）

ENV
  无。所有参数都是文件顶部的常量：SR / BPM / FPS / DUR / SEC_*

HOW TO CHANGE
  换片子：改 DUR 与 SEC_* 分节边界，让它们与画面 plate 的边界对齐；
  改 BPM 会同时改变「1 拍 = 多少帧」，画面那边要一起改。

NOTE
  这是参考实现（另一条 24 秒片子的乐谱），不是通用配乐机：
  直接跑会生成 24 秒的曲子，和 6 秒的骨架 demo 对不上，
  build.sh 会打印音画时长不一致的警告——那是提醒，不是报错。`);

  process.exit(0);
}

/* ============================================================
 * 0. 全局常量与时基
 * ============================================================ */
const SR = 44100;                    // 采样率
const BPM = 120;                     // 速度
const BEAT = 60 / BPM;               // 一拍 0.5 s
const BAR = BEAT * 4;                // 一小节 2.0 s
const FPS = 30;                      // 影片帧率
const FRAMES_PER_BEAT = BEAT * FPS;  // 15 帧/拍
const DUR = 24;                      // 总时长（秒）
const N = DUR * SR;                  // 每声道总帧数 = 1,058,400

const OUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'out/track.wav');

/** 拍 → 精确采样点。所有声部一律用它定位，绝不做浮点累加，避免累计漂移。 */
const S = (beat) => Math.round(beat * BEAT * SR);
/** 秒 → 采样点 */
const sLen = (sec) => Math.round(sec * SR);

// 段落边界（秒 → 拍 → 采样点），必须精确命中
const SEC_INK = 0, SEC_PIXEL = S(12), SEC_TYPE = S(26), SEC_OUTRO = S(38), SEC_END = S(48);
const INK_END = SEC_PIXEL;   // 6.0 s  = 264,600
const TYPE_END = SEC_OUTRO;  // 19.0 s = 837,900

/* ============================================================
 * 1. 确定性随机数与噪声源
 * ============================================================ */

/** mulberry32：32 位种子 PRNG，跨平台字节级可复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0x1a2b3c4d);   // 全局唯一随机源（种子写死 → 结果固定）

/** 预生成一整条白噪声，长度覆盖全曲；任何噪声事件都按"起始采样点"取切片，
 *  因此同一事件永远拿到同一段噪声，无需额外的顺序状态。 */
const NOISE = new Float32Array(N + SR);
for (let i = 0; i < NOISE.length; i++) NOISE[i] = rnd() * 2 - 1;
const noiseAt = (k) => NOISE[((k % NOISE.length) + NOISE.length) % NOISE.length];

/* ============================================================
 * 2. 基础工具：振荡器 / 包络 / 滤波器 / 混音总线
 * ============================================================ */

// ---- 2.1 音名 → 频率（十二平均律，A4 = 440 Hz）----
const SEMI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
function freq(name) {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name);
  if (!m) throw new Error('坏音名: ' + name);
  const midi = SEMI[m[1]] + (parseInt(m[2], 10) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---- 2.2 加法合成的带限波表 ----
// 直接对每个采样点求和在 JS 里太慢，且朴素锯齿/方波会严重混叠。
// 做法：按"基频"预生成一张单周期波表，只叠加 12 kHz 以下的谐波，
//       播放时线性插值读取 → 既带限又便宜，且完全确定。
const TAB_SIZE = 8192;
const TAB_MASK = TAB_SIZE - 1;
const tabCache = new Map();

function wavetable(kind, f) {
  const key = kind + '|' + f.toFixed(4);
  const hit = tabCache.get(key);
  if (hit) return hit;

  const tab = new Float32Array(TAB_SIZE);
  const maxH = Math.max(1, Math.floor(12000 / f));   // 谐波上限 12 kHz
  for (let h = 1; h <= maxH; h++) {
    let amp = 0;
    if (kind === 'saw') amp = 1 / h;
    else if (kind === 'square') { if (h % 2 === 0) continue; amp = 1 / h; }
    else if (kind === 'tri') { if (h % 2 === 0) continue; amp = (((h - 1) / 2) % 2 === 0 ? 1 : -1) / (h * h); }
    else throw new Error('未知波形: ' + kind);
    const w = (2 * Math.PI * h) / TAB_SIZE;
    for (let i = 0; i < TAB_SIZE; i++) tab[i] += amp * Math.sin(w * i);
  }
  let peak = 0;
  for (let i = 0; i < TAB_SIZE; i++) peak = Math.max(peak, Math.abs(tab[i]));
  if (peak > 0) for (let i = 0; i < TAB_SIZE; i++) tab[i] /= peak;

  tabCache.set(key, tab);
  return tab;
}

/** 生成一段带限振荡器（kind: 'saw' | 'square' | 'tri'） */
function osc(kind, f, len, phase0 = 0) {
  const tab = wavetable(kind, f);
  const out = new Float32Array(len);
  const inc = (f * TAB_SIZE) / SR;
  let p = phase0 * TAB_SIZE;
  for (let i = 0; i < len; i++) {
    const k = p | 0;
    const fr = p - k;
    const a = tab[k & TAB_MASK];
    const b = tab[(k + 1) & TAB_MASK];
    out[i] = a + (b - a) * fr;
    p += inc;
    if (p >= TAB_SIZE) p -= TAB_SIZE;
  }
  return out;
}

/** 纯正弦（相位为 0..1 的分数，逐样累加不丢精度） */
function sineBuf(f, len, phase0 = 0) {
  const out = new Float32Array(len);
  const inc = f / SR;
  let ph = phase0;
  for (let i = 0; i < len; i++) {
    out[i] = Math.sin(2 * Math.PI * ph);
    ph += inc;
    if (ph >= 1) ph -= 1;
  }
  return out;
}

// ---- 2.3 包络 ----
/** 线性 ADSR（a/d/r 单位秒，s 为 0..1 保持电平）；总长不足时按比例压缩各段 */
function adsr(len, a, d, s, r) {
  const out = new Float32Array(len);
  let A = sLen(a), D = sLen(d), R = sLen(r);
  const need = A + D + R;
  if (need > len) { const k = len / need; A = Math.round(A * k); D = Math.round(D * k); R = Math.round(R * k); }
  const Sus = Math.max(0, len - A - D - R);
  for (let i = 0; i < len; i++) {
    let g;
    if (i < A) g = A ? i / A : 1;
    else if (i < A + D) g = D ? 1 - (1 - s) * ((i - A) / D) : s;
    else if (i < A + D + Sus) g = s;
    else { const j = i - (A + D + Sus); g = R ? s * (1 - j / R) : 0; }
    out[i] = g < 0 ? 0 : g;
  }
  return out;
}

/** 指数衰减（tau 为 e 折时间，秒） */
function expEnv(len, tau, attack = 0.002) {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] = Math.exp(-t / tau) * (1 - Math.exp(-t / attack));
  }
  return out;
}

// ---- 2.4 简易滤波器（一阶，够用且便宜）----
function lp1(buf, fc) {
  const out = new Float32Array(buf.length);
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y = (1 - a) * buf[i] + a * y; out[i] = y; }
  return out;
}
function hp1(buf, fc) {
  const out = new Float32Array(buf.length);
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0, xp = 0;
  for (let i = 0; i < buf.length; i++) { y = a * (y + buf[i] - xp); xp = buf[i]; out[i] = y; }
  return out;
}
const bp = (buf, lo, hi) => lp1(hp1(buf, lo), hi);

/** 截止频率逐样变化的低通（做"慢速滤波涌流"） */
function lp1Sweep(buf, fcFn, state = { y: 0 }) {
  const out = new Float32Array(buf.length);
  let y = state.y;
  for (let i = 0; i < buf.length; i++) {
    const fc = Math.min(fcFn(i / SR), SR * 0.45);
    const a = Math.exp((-2 * Math.PI * fc) / SR);
    y = (1 - a) * buf[i] + a * y;
    out[i] = y;
  }
  state.y = y;
  return out;
}

// ---- 2.5 混音总线 ----
const L = new Float32Array(N);
const R = new Float32Array(N);

/** 单声道信号按等功率 pan 写入总线；start 为精确起始采样点 */
function mix(start, buf, gain = 1, pan = 0) {
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  const end = Math.min(start + buf.length, N);
  for (let k = Math.max(0, start), i = Math.max(0, -start); k < end; k++, i++) {
    L[k] += buf[i] * gl;
    R[k] += buf[i] * gr;
  }
}

/** 立体声缓冲直接写入总线（左右各自独立，用于有宽度的 pad） */
function mixStereo(start, bufL, bufR, gain = 1) {
  const end = Math.min(start + bufL.length, N);
  for (let k = Math.max(0, start), i = Math.max(0, -start); k < end; k++, i++) {
    L[k] += bufL[i] * gain;
    R[k] += bufR[i] * gain;
  }
}

/* ============================================================
 * 3. 乐器
 * ============================================================ */

// ---- 3.1 底鼓 Kick：正弦 + 极快音高下坠 + 短瞬态 ----
function kick(startBeat, { gain = 1, pan = 0, f0 = 140, f1 = 45, drop = 0.055, decay = 0.32, click = 0.22 } = {}) {
  const start = S(startBeat);
  const len = sLen(0.9);
  const out = new Float32Array(len);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / drop);        // 音高指数下坠 → "咚"
    ph += f / SR; if (ph >= 1) ph -= 1;
    const body = Math.sin(2 * Math.PI * ph) * Math.exp(-t / decay);
    const tr = click * noiseAt(start + i) * Math.exp(-t / 0.0035);  // 打击瞬态
    out[i] = Math.tanh((body + tr) * 1.5) * 0.75;          // 轻微饱和，更有冲击力
  }
  mix(start, out, gain, pan);
}

// ---- 3.2 闭合踩镲 Hat：高通噪声 + 极短指数衰减 ----
function hat(startBeat, { gain = 1, pan = 0.22, decay = 0.028, hp = 7500 } = {}) {
  const start = S(startBeat);
  const len = sLen(0.12);
  const raw = new Float32Array(len);
  const env = expEnv(len, decay, 0.0004);
  for (let i = 0; i < len; i++) raw[i] = noiseAt(start + i) * env[i];
  mix(start, hp1(raw, hp), gain, pan);
}

// ---- 3.3 军鼓/拍手 Snare-Clap：带通噪声散射 + 桶音 ----
function clap(startBeat, { gain = 1, pan = 0 } = {}) {
  const start = S(startBeat);
  const len = sLen(0.4);
  const n = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // 三次 ~9ms 间隔的微爆音，做出"拍手"的散射感，之后接一条短尾巴
    const b1 = Math.exp(-t / 0.012);
    const b2 = t > 0.009 ? Math.exp(-(t - 0.009) / 0.012) : 0;
    const b3 = t > 0.018 ? Math.exp(-(t - 0.018) / 0.014) : 0;
    const tail = t > 0.028 ? Math.exp(-(t - 0.028) / 0.085) * 0.55 : 0;
    n[i] = noiseAt(start + i) * (b1 + b2 + b3 + tail);
  }
  const body = bp(n, 900, 5200);
  // 叠一点 190 Hz 的"桶音"，让它在小喇叭上也有体积
  const tone = sineBuf(190, len);
  const tEnv = expEnv(len, 0.075, 0.001);
  for (let i = 0; i < len; i++) body[i] = body[i] * 0.9 + tone[i] * tEnv[i] * 0.25;
  mix(start, body, gain, pan);
}

// ---- 3.4 金属 tick：高通噪声 + 高频正弦点缀（"打字机"/"机械"质感）----
function tick(startBeat, { gain = 1, pan = 0, f = 2600, decay = 0.022, hp = 4200, ping = 0.35 } = {}) {
  const start = S(startBeat);
  const len = sLen(0.18);
  const raw = new Float32Array(len);
  const env = expEnv(len, decay, 0.0003);
  for (let i = 0; i < len; i++) raw[i] = noiseAt(start + i) * env[i];
  const click = hp1(raw, hp);
  const ping_ = sineBuf(f, len);
  const pEnv = expEnv(len, decay * 0.9, 0.0003);
  for (let i = 0; i < len; i++) click[i] += ping_[i] * pEnv[i] * ping;
  mix(start, click, gain, pan);
}

// ---- 3.5 吊镲 Crash：宽频噪声，慢衰减，越往后越暗 ----
function crash(startBeat, { gain = 0.7, pan = 0, decay = 1.7 } = {}) {
  const start = S(startBeat);
  const len = sLen(3.0);
  const n = new Float32Array(len);
  for (let i = 0; i < len; i++) n[i] = noiseAt(start + i);
  const bright = bp(n, 4200, 15000);                 // 亮层：衰减快一点
  const dark = bp(n, 900, 4500);                     // 暗层：拖尾长
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const atk = 1 - Math.exp(-t / 0.0015);
    out[i] = atk * (bright[i] * Math.exp(-t / (decay * 0.55)) * 0.8 + dark[i] * Math.exp(-t / decay) * 0.6);
  }
  mix(start, out, gain, pan);
}

// ---- 3.6 拨弦 Pluck：三角波 + 快速下扫低通 + 附点八分延迟回声 ----
function pluck(startBeat, note, { gain = 1, pan = -0.15, decay = 0.32, echoes = true } = {}) {
  const f = freq(note);
  const len = sLen(1.1);
  const raw = osc('tri', f, len);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    raw[i] *= Math.exp(-t / decay) * (1 - Math.exp(-t / 0.0025));
  }
  // 低通从 4 kHz 迅速关到 500 Hz → 拨弦的"哒"
  const swept = lp1Sweep(raw, (t) => 500 + 3500 * Math.exp(-t / 0.11));
  for (let i = 0; i < len; i++) out[i] = swept[i];

  mix(S(startBeat), out, gain, pan);
  if (echoes) {
    // 附点八分 = 0.75 拍 = 0.375 s；两次回声，音量递减
    mix(S(startBeat + 0.75), out, gain * 0.34, -pan);
    mix(S(startBeat + 1.5), out, gain * 0.13, pan * 1.4);
  }
}

// ---- 3.7 温暖 Pad：多个失谐锯齿，左右分开做宽度 + 慢速滤波扫频 ----
function pad(startBeat, durBeats, notes, opt = {}) {
  const {
    gain = 0.2, attack = 1.2, release = 1.2, sustain = 0.8,
    detune = 0.0035, hp = 60, sweep = null, width = 1.0, sub = null,
  } = opt;

  const start = S(startBeat);
  const len = Math.max(1, S(startBeat + durBeats) - start);
  const env = adsr(len, attack, 0.6, sustain, release);

  const bufL = new Float32Array(len);
  const bufR = new Float32Array(len);
  for (const name of notes) {
    const f = freq(name);
    const a = osc('saw', f * (1 - detune), len);
    const b = osc('saw', f * (1 + detune), len);
    for (let i = 0; i < len; i++) { bufL[i] += a[i]; bufR[i] += b[i]; }
  }
  // 可选：最底下垫一层正弦，撑住低频
  if (sub) {
    const s = sineBuf(freq(sub), len);
    for (let i = 0; i < len; i++) { bufL[i] += s[i] * 1.1; bufR[i] += s[i] * 1.1; }
  }
  const norm = 1 / notes.length;

  // 逐声道的滤波扫频（左右略有差异 → 自然的立体声呼吸）
  const stL = { y: 0 }, stR = { y: 0 };
  const fcL = sweep ? (t) => sweep(t) : () => 1600;
  const fcR = sweep ? (t) => sweep(t) * 0.94 : () => 1500;
  const fL = lp1Sweep(bufL, fcL, stL);
  const fR = lp1Sweep(bufR, fcR, stR);
  const hL = hp1(fL, hp), hR = hp1(fR, hp);

  // 宽度：把一部分反向折叠，保持单声道兼容
  for (let i = 0; i < len; i++) {
    const m = (hL[i] + hR[i]) * 0.5;
    const sl = hL[i] - m, sr = hR[i] - m;
    hL[i] = (m + sl * width) * env[i] * norm;
    hR[i] = (m + sr * width) * env[i] * norm;
  }
  mixStereo(start, hL, hR, gain);
}

/* ============================================================
 * 4. 编曲（段落严格对齐剪辑点）
 * ============================================================ */

// 和弦库与进行：每 2 拍换和弦，2 小节 = 一个完整乐句 Am - F - C - G
const CHORDS = {
  Am: ['A2', 'C3', 'E3', 'A3'],
  F: ['F2', 'A2', 'C3', 'F3'],
  C: ['C3', 'E3', 'G3', 'C4'],
  G: ['G2', 'B2', 'D3', 'G3'],
};
const PROG = ['Am', 'F', 'C', 'G'];
const PROG_ORIGIN = 12;   // 进行从第 12 拍（6.0 s，pixel 段起点）开始计
const chordAt = (beat) => PROG[(((Math.floor((beat - PROG_ORIGIN) / 2) % 4) + 4) % 4)];

/* ------------------------------------------------------------
 * 4.1 「ink」0.0 – 6.0 s（第 0 – 12 拍）：稀疏、安静、Am 长音铺底
 * ------------------------------------------------------------ */
{
  // 低频 drone：Am，慢起 → 慢速滤波涌流 → 在 6.0 s 精确收干净
  pad(0, 12, CHORDS.Am, {
    gain: 0.16, attack: 1.7, release: 1.6, sustain: 0.78,
    detune: 0.0028, hp: 45, width: 1.15, sub: 'A1',
    // 截止频率：暗 → 亮 → 略收（"slow filter-ish swell"）
    sweep: (t) => 220 + 900 * (t / 6) + 420 * Math.sin((Math.PI * t) / 6),
  });

  // 打字机 tick：1.0 – 5.5 s 之间零散几下（种子随机，但结果固定）
  {
    let t = 1.0;
    while (t < 5.5) {
      t += 0.18 + rnd() * 0.55;                    // 不规则间隔
      if (t >= 5.5) break;
      const accent = rnd();
      tick(t / BEAT, {
        gain: 0.10 + accent * 0.07,
        pan: (rnd() * 2 - 1) * 0.45,
        f: 1900 + rnd() * 1800,
        decay: 0.012 + rnd() * 0.018,
        hp: 3600,
      });
    }
  }

  // 最后 1.5 s 的上升涌流（4.5 – 6.0 s），能量在 6.0 精确收束，
  // 由 pixel 段第一拍底鼓完成"落点"。
  {
    const start = S(9), len = S(12) - S(9);        // 132,300 帧
    const out = new Float32Array(len);
    // 噪声层：一阶低通，截止频率随时间上移 → 越到后面越亮、越"嘶"
    //（注意：低通必须写成 y = (1-a)x + a*y 的漏式积分；写成 y += a*x 会变成
    //  无界累加的随机游走，末端会糊成一大团低频轰隆）
    let lpY = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const fc = 300 * Math.pow(16, t);            // 300 Hz → 4.8 kHz
      const a = Math.exp((-2 * Math.PI * fc) / SR);
      lpY = (1 - a) * noiseAt(start + i) + a * lpY;
      out[i] = lpY * 1.7 * Math.pow(t, 2.2);
    }
    // 音高层：A3 向上滑到 A4，八度叠加
    let p1 = 0, p2 = 0;
    const o1 = new Float32Array(len), o2 = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const f1 = 220 * Math.pow(2, t);
      p1 += f1 / SR; if (p1 >= 1) p1 -= 1;
      p2 += (f1 * 2) / SR; if (p2 >= 1) p2 -= 1;
      const g = Math.pow(t, 2.6);
      o1[i] = Math.sin(2 * Math.PI * p1) * g;
      o2[i] = Math.sin(2 * Math.PI * p2) * g * 0.4;
    }
    for (let i = 0; i < len; i++) out[i] = out[i] * 0.5 + o1[i] * 0.5 + o2[i] * 0.25;
    // 末尾 30ms 收一下，避免硬切产生咔哒（能量仍在 6.0 s 归零，落点由底鼓给出）
    const tail = sLen(0.03);
    for (let i = 0; i < tail; i++) out[len - tail + i] *= 1 - i / tail;
    // 注意：涌流是持续噪声，感知响度远高于同峰值的打击音，电平必须压得住
    mix(start, out, 0.30, 0);
  }
}

/* ------------------------------------------------------------
 * 4.2 「pixel」6.0 – 13.0 s（第 12 – 26 拍）：chiptune 律动
 * ------------------------------------------------------------ */
{
  const P_START = 12, P_END = 26;

  // 底鼓：每小节第 1、3 拍
  for (let b = P_START; b < P_END; b += 2) {
    kick(b, { gain: 0.78, f0: 150, f1: 48, drop: 0.05, decay: 0.26, click: 0.18 });
  }

  // 闭合踩镲：每一个八分音符
  for (let b = P_START; b < P_END; b += 0.5) {
    hat(b, { gain: b % 1 === 0 ? 0.19 : 0.115, decay: b % 1 === 0 ? 0.03 : 0.022 });
  }

  // 方波贝斯琶音：八分音符，每 2 拍走完一个和弦的四个和弦音
  for (let b = P_START; b < P_END; b += 0.5) {
    const chord = CHORDS[chordAt(b)];
    const idx = Math.round((b - P_START) * 2) % 4;
    const f = freq(chord[idx]);
    const len = sLen(0.24);
    const env = adsr(len, 0.004, 0.03, 0.7, 0.12);
    const o = osc('square', f, len);
    // 方波低音加一层低八度正弦，补足厚度
    const sub = sineBuf(f / 2, len);
    for (let i = 0; i < len; i++) o[i] = (o[i] * 0.75 + sub[i] * 0.35) * env[i] * 0.5;
    mix(S(b), o, 0.42, 0);
  }

  // 明亮的方波主音：一小节一个长音，构成 4 音动机 E5 - D5 - C5 - B4
  const MOTIF = ['E5', 'D5', 'C5', 'B4'];
  [12, 16, 20, 24].forEach((barBeat, k) => {
    const len = Math.min(S(barBeat + 3.5), S(P_END)) - S(barBeat);
    const f = freq(MOTIF[k]);
    const o = osc('square', f, len);
    const env = adsr(len, 0.01, 0.15, 0.62, 0.5);
    for (let i = 0; i < len; i++) o[i] = o[i] * env[i] * 0.42;
    mix(S(barBeat), o, 0.44, k % 2 === 0 ? -0.18 : 0.18);
    // 八度上方叠一层弱音，让 lead 更"亮"
    const o2 = osc('square', f * 2, len);
    for (let i = 0; i < len; i++) o2[i] *= env[i] * 0.10;
    mix(S(barBeat), o2, 0.44, k % 2 === 0 ? 0.18 : -0.18);
  });
}

/* ------------------------------------------------------------
 * 4.3 「type」13.0 – 19.0 s（第 26 – 38 拍）：更硬、更推进
 * ------------------------------------------------------------ */
{
  const T_START = 26, T_END = 38;

  // 四踩底鼓：每一拍
  for (let b = T_START; b < T_END; b += 1) {
    kick(b, { gain: b % 4 === 0 ? 0.95 : 0.82, f0: 165, f1: 46, drop: 0.045, decay: 0.22, click: 0.2 });
  }

  // 军鼓/拍手：每小节第 2、4 拍
  for (let b = T_START; b < T_END; b += 1) {
    if (((b % 4) + 4) % 4 === 1 || ((b % 4) + 4) % 4 === 3) clap(b, { gain: 0.55 });
  }

  // 直八贝斯：继续 Am - F - C - G 的琶音，音更短更紧
  for (let b = T_START; b < T_END; b += 0.5) {
    const chord = CHORDS[chordAt(b)];
    const idx = Math.round((b - PROG_ORIGIN) * 2) % 4;
    const f = freq(chord[idx]);
    const len = sLen(0.22);
    const env = adsr(len, 0.003, 0.02, 0.75, 0.10);
    const o = osc('saw', f, len);
    const sub = sineBuf(f / 2, len);
    for (let i = 0; i < len; i++) o[i] = (o[i] * 0.6 + sub[i] * 0.45) * env[i];
    mix(S(b), lp1(o, 2600), 0.42, 0);
  }

  // 反拍金属 tick：每个"和"（拍的后半）
  for (let b = T_START; b < T_END; b += 1) {
    tick(b + 0.5, { gain: 0.17, pan: 0.35, f: 3200 + (b % 2) * 900, decay: 0.016, hp: 5000, ping: 0.5 });
  }

  // 19.0 s 前的上升 riser（18.0 – 19.0 s），在 19.0 硬切
  {
    const start = S(36), len = S(38) - S(36);     // 44,100 帧
    const out = new Float32Array(len);
    let acc = 0, lpY = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // 噪声 + 上移的带通
      const fc = 500 * Math.pow(10, t);
      const a = Math.exp((-2 * Math.PI * fc) / SR);
      lpY = (1 - a) * noiseAt(start + i) + a * lpY;
      // 音高层：正弦从 200 Hz 上滑到 1.6 kHz，随后加速
      acc += (200 * Math.pow(2, 3 * t * t)) / SR; if (acc >= 1) acc -= 1;
      const ramp = Math.pow(t, 1.8);
      out[i] = (lpY * 0.55 + Math.sin(2 * Math.PI * acc) * 0.45) * ramp;
    }
    // 尾巴上加一个快速的振幅抖动，制造"紧张感"
    for (let i = 0; i < len; i++) {
      const t = i / len;
      out[i] *= 1 + 0.25 * Math.sin(2 * Math.PI * (8 + 26 * t) * (i / SR));
    }
    mix(start, out, 0.28, 0);
  }
}

/* ------------------------------------------------------------
 * 4.4 「outro」19.0 – 24.0 s（第 38 – 48 拍）：撞击 + 暖 pad + 拨弦
 * ------------------------------------------------------------ */
{
  // 19.0 s 的干净撞击
  crash(38, { gain: 0.95, decay: 1.7, pan: 0 });

  // 暖 pad：Am 起（19.0），21.0 走一下 F 作为经过，22.5 落在最终 Am 上
  pad(38, 4, CHORDS.Am, {
    gain: 0.42, attack: 1.1, release: 1.0, sustain: 0.85,
    detune: 0.0032, hp: 70, width: 1.1, sub: 'A1',
    sweep: (t) => 500 + 500 * Math.exp(-t / 1.4),
  });
  pad(42, 3, CHORDS.F, {
    gain: 0.21, attack: 0.7, release: 1.0, sustain: 0.75,
    detune: 0.004, hp: 90, width: 1.0,
    sweep: () => 900,
  });

  // 稀疏的延迟拨弦旋律（A 小调，落点在 22.0 的 D 上形成挂留）
  pluck(39.5, 'A4', { gain: 0.38, decay: 0.34, pan: -0.28 });
  pluck(41.0, 'C5', { gain: 0.33, decay: 0.30, pan: 0.24 });
  pluck(42.5, 'E5', { gain: 0.30, decay: 0.28, pan: -0.2 });
  pluck(44.0, 'D5', { gain: 0.28, decay: 0.30, pan: 0.3 });

  // 22.5 s 的最终解决和弦：Am 的宽 Voicing，慢起、长衰减，24.0 前自然归零
  {
    const start = S(45);
    const len = N - start;                        // 到曲尾
    const notes = ['A2', 'E3', 'A3', 'C4', 'E4'];
    const bufL = new Float32Array(len), bufR = new Float32Array(len);
    for (const nm of notes) {
      const f = freq(nm);
      const a = osc('saw', f * 0.9975, len);
      const b = osc('saw', f * 1.0025, len);
      for (let i = 0; i < len; i++) { bufL[i] += a[i]; bufR[i] += b[i]; }
    }
    const s = sineBuf(freq('A1'), len);
    for (let i = 0; i < len; i++) { bufL[i] += s[i] * 0.9; bufR[i] += s[i] * 0.9; }
    // 包络：0.08 s 起音 → 缓慢衰减到 0（正好在 24.0 s 归零）
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const atk = 1 - Math.exp(-t / 0.03);
      const dec = Math.pow(1 - i / len, 1.6) * Math.exp(-t / 1.35);
      const g = atk * dec * 0.2;
      bufL[i] *= g; bufR[i] *= g;
    }
    const fL = hp1(lp1(bufL, 2600), 70);
    const fR = hp1(lp1(bufR, 2400), 70);
    mixStereo(start, fL, fR, 0.42);
  }
}

/* ============================================================
 * 5. 母带：软削波 → 峰值归一化 → 尾部淡出
 * ============================================================ */

// 5.0 隔直：一阶高通 20 Hz，去掉合成过程中积累的直流（否则波形整体偏离零点）
{
  const a = Math.exp((-2 * Math.PI * 20) / SR);
  let yl = 0, xl = 0, yr = 0, xr = 0;
  for (let i = 0; i < N; i++) {
    yl = a * (yl + L[i] - xl); xl = L[i]; L[i] = yl;
    yr = a * (yr + R[i] - xr); xr = R[i]; R[i] = yr;
  }
}

// 5.1 软削波（tanh）：先把整体推到一个略超 1.0 的峰值，让 tanh 温柔地抹圆顶点
{
  let peak = 0, peakAt = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    const m = a > b ? a : b;
    if (m > peak) { peak = m; peakAt = i; }
  }
  if (process.env.DBG) console.log('  [dbg] 母带前峰值 ' + peak.toFixed(4) + ' @ ' + (peakAt / SR).toFixed(4) + 's');
  const drive = 1.15 / (peak || 1);
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh(L[i] * drive);
    R[i] = Math.tanh(R[i] * drive);
  }
}

// 5.2 峰值归一化到 -1.5 dBFS
const TARGET = Math.pow(10, -1.5 / 20);   // ≈ 0.8414
{
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const g = TARGET / (peak || 1);
  for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }
}

// 5.3 最后 0.15 s 淡出，保证文件在 0 附近干净收尾（不是硬切）
{
  const fade = sLen(0.15);
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);   // 升余弦，反向使用
    const k = N - fade + i;
    L[k] *= g; R[k] *= g;
  }
  L[N - 1] = 0; R[N - 1] = 0;
}

/* ============================================================
 * 6. WAV 编码与输出
 * ============================================================ */
function encodeWav16(l, r) {
  const frames = l.length;
  const dataBytes = frames * 2 * 2;               // 2 声道 × 2 字节
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);                      // fmt chunk 大小
  buf.writeUInt16LE(1, 20);                       // PCM
  buf.writeUInt16LE(2, 22);                       // 声道数
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 2, 28);              // 字节率
  buf.writeUInt16LE(4, 32);                       // block align
  buf.writeUInt16LE(16, 34);                      // 位深
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const a = Math.max(-1, Math.min(1, l[i]));
    const b = Math.max(-1, Math.min(1, r[i]));
    buf.writeInt16LE(Math.round(a * 32767), o); o += 2;
    buf.writeInt16LE(Math.round(b * 32767), o); o += 2;
  }
  return buf;
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
const wav = encodeWav16(L, R);
writeFileSync(OUT_PATH, wav);

// ---- 统计与自检 ----
let peak = 0, sumSq = 0, dc = 0;
for (let i = 0; i < N; i++) {
  for (const v of [L[i], R[i]]) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    dc += v;
  }
}
const rms = Math.sqrt(sumSq / (N * 2));
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** 每 1 秒一桶的 RMS，用来核对段落动态 */
const buckets = [];
for (let s = 0; s < DUR; s++) {
  let acc = 0, cnt = 0;
  for (let k = s * SR; k < (s + 1) * SR; k++) { acc += L[k] * L[k] + R[k] * R[k]; cnt += 2; }
  buckets.push(Math.sqrt(acc / cnt));
}

const md5 = createHash('md5').update(wav).digest('hex');
console.log('—— 合成完成 ——');
console.log('输出文件   : ' + OUT_PATH);
console.log('格式       : 44100 Hz / 立体声 / 16-bit PCM');
console.log('时长       : ' + (N / SR).toFixed(3) + ' s（每声道 ' + N + ' 帧，' + wav.length + ' 字节）');
console.log('峰值       : ' + peak.toFixed(6) + '  (' + db(peak).toFixed(2) + ' dBFS)');
console.log('整体 RMS   : ' + rms.toFixed(6) + '  (' + db(rms).toFixed(2) + ' dBFS)');
console.log('直流偏移   : ' + (dc / (N * 2)).toExponential(2));
console.log('MD5        : ' + md5);
console.log('每秒 RMS (dBFS): ' + buckets.map((v, i) => i + 's:' + db(v).toFixed(1)).join('  '));
console.log(
  '一句话总结 : A 小调 120BPM 24.0s 立体声配乐 —— ink 段 Am 长音 drone + 打字机 tick + 上升涌流(0-6s)、' +
  'pixel 段 chiptune 律动(6-13s)、type 段四踩推进 + riser(13-19s)、outro 段撞击 + 暖 pad + 延迟拨弦(19-24s)，' +
  '峰值归一化 -1.5 dBFS，tanh 软削波。'
);
