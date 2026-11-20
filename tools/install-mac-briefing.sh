#!/bin/sh
# macOS: 아침 브리핑을 매일 09:00과 로그인 때 띄우도록 launchd에 등록한다 (윈도우의 작업 스케줄러 역할).
#   등록:   sh tools/install-mac-briefing.sh
#   그만둠: sh tools/install-mac-briefing.sh --remove
# cron은 화면 세션 밖에서 돌아 창을 못 띄울 수 있어서 launchd(LaunchAgent)를 쓴다.
# 09:00에 맥이 잠자기였으면 깨어난 뒤에 한 번 뜬다. 하루 한 번 제한은 briefing.js가 지킨다.
set -e
LABEL=com.todo-splitter.briefing
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
if [ "$1" = "--remove" ]; then
  rm -f "$PLIST"
  echo "아침 브리핑 등록을 지웠습니다"
  exit 0
fi

# plist는 XML이라 경로의 &, <, > 를 바꿔 넣는다
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
APP="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)" || { echo "Node.js를 찾지 못했습니다: https://nodejs.org"; exit 1; }
APP_X="$(xml "$APP")"
NODE_X="$(xml "$NODE")"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_X</string><string>$APP_X/tools/briefing.js</string></array>
  <key>WorkingDirectory</key><string>$APP_X</string>
  <key>EnvironmentVariables</key>
  <dict><key>LANG</key><string>ko_KR.UTF-8</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF

# 바로 앞의 bootout이 끝나기 전이면 등록이 실패할 수 있어 몇 번 다시 해 본다
ok=
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { echo "등록하지 못했습니다. 잠시 뒤 다시 실행해 보세요"; exit 1; }
echo "등록했습니다: 매일 09:00과 로그인 때 아침 브리핑이 뜹니다 (오늘 아직 안 봤으면 지금 한 번 뜹니다)"
