#!/bin/sh
# Installs Corral into the Herdr app on this computer: links each mod and the
# layout from this folder into Herdr's home, so `git pull` updates them. Needs
# nothing but sh. Never replaces a file that isn't one of these links.
#
#   ./install.sh            link, then switch this window to the corral layout
#   ./install.sh --remove   remove the links (switch layouts first)
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
if [ ! -d "$home" ]; then
  echo "No Herdr app home at $home. Open Herdr once, or set HERDR_APP_HOME (herdr-app --help shows it)." >&2
  exit 1
fi
mkdir -p "$home/mods" "$home/layouts"
problems=0
link() { # source target
  if [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; then return; fi
  if [ -e "$2" ] || [ -L "$2" ]; then echo "skipped $2: something else is there" >&2; problems=1; return; fi
  ln -s "$1" "$2" && echo "linked  $2"
}
unlink_ours() { # source target
  if [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; then rm "$2" && echo "removed $2"; fi
}
for d in "$here"/mods/corral-*; do
  [ -d "$d" ] || continue
  if [ "${1:-}" = "--remove" ]; then unlink_ours "$d" "$home/mods/$(basename "$d")"; else link "$d" "$home/mods/$(basename "$d")"; fi
done
for f in "$here"/layouts/*.json "$here"/layouts/*.svg; do
  [ -f "$f" ] || continue
  if [ "${1:-}" = "--remove" ]; then unlink_ours "$f" "$home/layouts/$(basename "$f")"; else link "$f" "$home/layouts/$(basename "$f")"; fi
done
[ "${1:-}" = "--remove" ] && exit 0
if command -v herdr-app >/dev/null 2>&1 && herdr-app do layout.switch '{"name":"corral"}' >/dev/null 2>&1; then
  echo "Herdr now shows the corral layout."
else
  echo "Open Herdr's settings and pick the corral layout."
fi
exit $problems
