#!/usr/bin/env bash
# 安卓真机列表滚动实测：在当前前台页面上自动来回快滑，取帧耗时分布和内存。
# 用法：perf-android-scroll.sh <标签> [来回轮数，默认 12]
# 前提：手机已连 adb，应用停在要测的列表页（会话列表 / 笔记列表）。
set -euo pipefail

PKG="${PERF_PKG:-com.yiboding.circleim.preprod}"
LABEL="${1:?需要一个标签，例如 conversations}"
ROUNDS="${2:-12}"
OUT="${PERF_OUT:-${TMPDIR:-/tmp}/circle-perf-results}/android-scroll"
mkdir -p "$OUT"

# 折叠屏内外屏尺寸不同，dumpsys 里排第一的不一定是亮着的那块：以界面根节点的范围为准。
adb shell uiautomator dump /sdcard/perf-ui.xml >/dev/null 2>&1
read -r W H < <(adb shell cat /sdcard/perf-ui.xml | grep -oE 'bounds="\[0,0\]\[[0-9]+,[0-9]+\]"' | head -1 | sed -E 's/.*\[([0-9]+),([0-9]+)\]"/\1 \2/')
X=$((W / 2)); TOP=$((H * 28 / 100)); BOTTOM=$((H * 78 / 100))

front=$(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity' || true)
case "$front" in *"$PKG"*) ;; *) echo "前台不是 $PKG，先把应用打开到要测的列表页。" >&2; exit 1 ;; esac

mem_before=$(adb shell dumpsys meminfo "$PKG" | awk '/TOTAL PSS:/{print $3; exit}')
adb logcat -c
adb shell dumpsys gfxinfo "$PKG" reset >/dev/null

for _ in $(seq 1 "$ROUNDS"); do
  for _ in 1 2 3; do adb shell input swipe "$X" "$BOTTOM" "$X" "$TOP" 120; sleep 0.45; done
done
for _ in $(seq 1 "$ROUNDS"); do
  for _ in 1 2 3; do adb shell input swipe "$X" "$TOP" "$X" "$BOTTOM" 120; sleep 0.45; done
done
sleep 1

adb shell dumpsys gfxinfo "$PKG" > "$OUT/$LABEL-gfxinfo.txt"
mem_after=$(adb shell dumpsys meminfo "$PKG" | awk '/TOTAL PSS:/{print $3; exit}')
adb logcat -d -s Choreographer:I ActivityManager:E > "$OUT/$LABEL-logcat.txt" || true

echo "== ${LABEL} (屏幕 ${W}x${H}, 来回各 $((ROUNDS * 3)) 次快滑)"
grep -E 'Total frames rendered|Janky frames:|50th percentile|90th percentile|95th percentile|99th percentile|Number Missed Vsync|Number Slow UI thread|Number Slow bitmap uploads|Number Slow issue draw commands|Number Frame deadline missed' "$OUT/$LABEL-gfxinfo.txt" | sed 's/^ *//'
echo "内存 PSS：滑动前 $((mem_before / 1024)) MB → 滑动后 $((mem_after / 1024)) MB"
echo "系统记录的丢帧告警：$(grep -c 'Skipped' "$OUT/$LABEL-logcat.txt" || true) 条"
