#!/usr/bin/env bash
# 把 frames/f%05d.png 编成 out/film.mp4（带配乐），并做完整性校验。
#
#   ./build.sh            720 帧 + out/track.wav
#   FPS=30 ./build.sh ...
#
# 三个必须做对的地方（framewright 的实测结论）：
#   1) -pix_fmt yuv420p        —— 否则播放器里可能解不出来
#   2) BT.709 矩阵转换 + 打标  —— ffmpeg 单独跑会用 BT.601 且不打标，
#      播放器按 BT.709 解读 HD 视频，饱和色会偏（实测纯绿偏 39 个 level）
#   3) 先写临时文件，编码成功才 rename —— 避免留下一个半截的 mp4
set -euo pipefail
cd "$(dirname "$0")"

FPS=${FPS:-30}
CRF=${CRF:-22}
FRAMES=${FRAMES:-frames}
AUDIO=${AUDIO:-out/track.wav}
OUT=${OUT:-out/film.mp4}
TMP="${OUT%.mp4}.tmp.mp4"

[ -d "$FRAMES" ] || { echo "没有 $FRAMES/，先跑 node render.mjs $FRAMES"; exit 1; }
N=$(ls "$FRAMES"/f*.png 2>/dev/null | wc -l)
echo "帧数 $N @ ${FPS}fps = $(echo "scale=3; $N/$FPS" | bc)s"

if [ -f "$AUDIO" ]; then
  AUD=(-i "$AUDIO" -c:a aac -b:a 192k -shortest)
  echo "配乐 $AUDIO"
else
  AUD=()
  echo "（没有 $AUDIO，出无声片）"
fi

ffmpeg -y -loglevel error -stats \
  -framerate "$FPS" -i "$FRAMES/f%05d.png" \
  "${AUD[@]}" \
  -c:v libx264 -preset slow -crf "$CRF" -maxrate 14M -bufsize 28M \
  -pix_fmt yuv420p \
  -vf "scale=in_range=full:out_range=limited,colorspace=all=bt709:iall=bt709:fast=1" \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -movflags +faststart \
  "$TMP"
mv "$TMP" "$OUT"

echo "--- 校验 ---"
V=$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,width,height,pix_fmt,color_space,color_primaries -of default=nw=1 "$OUT")
echo "$V"
D=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
echo "时长 $D s（期望 $(echo "scale=3; $N/$FPS" | bc)）"
echo "-> $OUT  $(du -h "$OUT" | cut -f1)"
