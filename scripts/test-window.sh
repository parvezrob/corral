#!/bin/sh
# A private Herdr window on an invisible display (Xvfb), for testing the mods
# without touching anyone's screen. It has its own app home (focus, layout,
# settings) and connects to this machine's herdr-core like any Herdr window.
#
#   scripts/test-window.sh            start it (runs until stopped)
#   HERDR_APP_HOME=~/.cache/wbt herdr-app do <command>    drive it
#   HERDR_APP_HOME=~/.cache/wbt herdr-app shot out.png     see it
#
# Mouse and keyboard can't be faked into it (no input devices on Xvfb), so drive
# it with commands: layout.select, space.select, wb-files.open:<path>,
# wb-git.diff:<path>. Needs: sudo apt install xvfb.
set -eu
home=${HERDR_TEST_HOME:-$HOME/.cache/wbt}   # short: the control socket path has a length limit
mkdir -p "$home"
[ -f "$home/shared.json" ] || printf '{"frame.welcomed":"finished","layout":"workbench"}\n' > "$home/shared.json"
[ -f "$home/settings.json" ] || printf '{"zoom":1.0,"telemetry":false,"sounds":{"enabled":false}}\n' > "$home/settings.json"
cd "$(dirname "$0")/.."
HERDR_APP_HOME=$home node scripts/link.mjs
exec env -u WAYLAND_DISPLAY HERDR_APP_HOME="$home" HERDR_TELEMETRY=0 \
  xvfb-run -a -s "-screen 0 1600x1000x24" herdr-app >"$home/run.log" 2>&1
