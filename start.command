#!/bin/sh
# macOS: Finder에서 더블클릭하면 터미널이 열리고 서버가 켜진다. 끌 때는 터미널 창을 닫거나 Ctrl+C.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 이상이 필요합니다: https://nodejs.org"
  read -r _
  exit 1
fi
exec node server.js
