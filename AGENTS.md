# AGENTS.md

这个仓库是**一条已经做完的片子**：《每一帧都是时间的函数》，24.0 秒 / 720 帧 / 30fps / 1920×1080，
四段风格各异的镜头，配乐是纯 Node 合成出来的。成片就在 `out/film.mp4`。

它同时是那套工作流的**示例产物**——工具与流程本身在另一个仓库
[code-animation-kit](https://github.com/turboegg1145/code-animation-kit)，
那里的 `.agents/skills/code-animation/` 是完整技能包（流程、参考资料、脚本）。

## 怎么跑

```bash
npm i
# 还要一个 Chrome：用系统装的（apt install ./google-chrome-stable_*.deb；没有 sudo 就 dpkg-deb -x 到 ~/.local/opt/）
# 脚本按 CHROME -> 系统路径 -> ~/.cache/puppeteer 的顺序找，所以缓存里那份即使被删也不影响
node shot.mjs 0 90 400        # 只看三帧（改画面时的主力）
SHEET=shots/sheet.png node render.mjs frames 7   # 24 格拉片自检
node render.mjs frames 7      # 全片 720 帧（4 标签页，约 3.5 分钟）
./build.sh                    # 编码 -> out/film.mp4
node audio.mjs                # 重新合成配乐 -> out/track.wav（约 5 秒，确定性）
```

浏览器里实时预览：直接打开 `film/index.html`，`?f=250` 跳单帧，`?grid=24&cw=440` 出拉片，`?s=12` 换种子。

## 改这个片子时必须守的规矩

这部片子的每一帧都是 `(帧号, 种子, 宽度)` 的纯函数——这是它能被逐帧渲染、能被 seek、两次渲染像素一致的原因。
下面每一条被违反，都会在成片里变成一个看得见的故障：

1. **不要引入跨帧状态**：不用 `Date.now()`、`Math.random()`、全局累加器，也不能依赖"上一帧画了什么"。
   随机一律走 `hash()` / `rng()`。要拖尾或运动模糊，就把物体在 `t−k·dt` 重画 6–10 次、透明度递减。
2. **画布池的出口必须干净**：拿到画布先 `wipe(g)`，`save()` 过的必须 `restore()`，`clip`/`shadowBlur`/
   `globalCompositeOperation`/`globalAlpha` 用完要还原。池里的画布跨帧复用，泄漏会让帧依赖渲染顺序。
   **注意 `cvs(name,w,h)` 返回的是画布，`wipe(cvs(...).getContext('2d'))` 返回的是上下文，两者不能混用。**
3. **不要碰输出像素**：场景只画逻辑坐标（短边 1080），缩放交给引擎。
4. **时间对齐节拍，不写死帧号**：段内用 `S.i`，跨段用全局帧 `S.f` 和 `at('段名', 拍数)`。
   数值要在**同一个时间基准**里相减——把局部帧 `S.i` 和全局帧相减是这部片子里真实踩过的坑。
5. **改完必须看一眼**：任何画面改动之后至少 `node shot.mjs <受影响的帧>`；改完一整段跑一次拉片。
   没出过拉片不要重渲全片——720 帧要 3.5 分钟，而问题在第 1 帧的静帧里就看得见。
6. **渲染器与编码参数不是画面参数**：不要为了画面好看去改 `render.mjs`、`build.sh`、帧率或
   `--disable-accelerated-2d-canvas`。

## 这个片子里特有的三个陷阱

- **递归闸门。** 第 4 段 `phos` 会把全片 24 格联系表当素材画进画面，而联系表本身是逐帧渲染出来的——
  所以有 `IN_SHEET`（联系表内部不再嵌套建表）和 `DEPTH`（嵌套渲染用 `content@N` 画布，不踩外层正在画的画布）两个闸门。
  动 `buildSheet()` 之前先搞清这两个开关。
- **转场会吃掉末帧。** `cut()` 默认给每段最后 3 帧压黑，片尾那段必须 `cutOut:false`，否则最后一帧是全黑。
- **首尾相接**靠最后 10 帧淡回**第 0 帧的渲染结果**（`renderFrame(0,...)` 画进 `loop` 画布再叠上去），
  不是淡成纸色。改第 0 帧的构图就要重新确认首尾是否还对得上。

## 更多

- 想改画面：改 `film/index.html`，九节顺序别乱（参数 → 生成器 → 数学 → 画布池 → 调色板 → **辅助函数** → 引擎 → 分镜 → boot）。
  辅助函数必须在分镜块之上，否则删掉一段镜头会把夹在中间的辅助函数一起删掉。
- 想改配乐：改 `audio.mjs` 顶部的 `DUR`、`SEC_*`（分节必须与 `film/index.html` 里 plate 的边界对齐）。
- 想知道为什么这么做：`README.md` 写了做这条片子踩的 8 个坑；完整方法论在 kit 仓库的
  `.agents/skills/code-animation/references/`。
