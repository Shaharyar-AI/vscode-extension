#!/usr/bin/env bash
#
# CR-Track installer.
#
#   curl -fsSL https://<host>/install.sh | bash
#
# Downloads the current .vsix and installs it into VS Code. Written to be read
# before it is run — piping a script from the internet into a shell deserves
# that much.
#
# Environment:
#   CR_TRACK_BASE   override the download host
#   CODE_BIN        use a specific editor CLI (code, code-insiders, cursor…)
#   CR_TRACK_FORCE  set to 1 to reinstall even if the version already matches

set -euo pipefail
# Cmd on macOS, Ctrl on Linux. One script serves both, and the palette shortcut
# is the first instruction a new developer is given — printing the wrong one
# reads as a script written for somebody else's machine.
case "$(uname -s 2>/dev/null || echo Linux)" in
  Darwin) MOD="Cmd" ;;
  *)      MOD="Ctrl" ;;
esac

# ── The host these scripts download from ──────────────────────────────────
#
# SELF-HOSTING: change this one line to your own origin. It must serve
# `version.txt` and `cr-track-latest.vsix` at the paths below — the two files
# this script fetches. Nothing else here needs touching.
#
# Or leave it and set CR_TRACK_BASE in the environment instead.
BASE="${CR_TRACK_BASE:-https://cr-track-dashboard.vercel.app}"
TMP=""

# ── output ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
warn() { printf '%s warning:%s %s\n' "$YELLOW" "$OFF" "$*" >&2; }
die()  { printf '%s error:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

cleanup() { [ -n "$TMP" ] && rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

# ── find the editor ───────────────────────────────────────────────────────
# `code` is frequently absent from PATH on macOS, where VS Code ships the CLI
# inside the app bundle and only adds it on request. Failing with "command not
# found" there would be technically correct and completely unhelpful.
find_code() {
  if [ -n "${CODE_BIN:-}" ]; then
    command -v "$CODE_BIN" >/dev/null 2>&1 && { printf '%s' "$CODE_BIN"; return 0; }
    [ -x "$CODE_BIN" ] && { printf '%s' "$CODE_BIN"; return 0; }
    die "CODE_BIN is set to '$CODE_BIN' but that is not runnable"
  fi

  local candidate
  for candidate in code code-insiders codium cursor windsurf; do
    if command -v "$candidate" >/dev/null 2>&1; then printf '%s' "$candidate"; return 0; fi
  done

  # Not on PATH. Look where each platform's installer actually puts it.
  #
  # macOS ships the CLI inside the .app bundle and only adds it to PATH when
  # asked. Linux has no single answer at all: a distribution package, Snap,
  # Flatpak and a tarball in /opt each land somewhere different, and a developer
  # on Flatpak looks identical to one with no editor at all unless the exported
  # binary is checked by name.
  local bundled
  for bundled in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
    "/Applications/VSCodium.app/Contents/Resources/app/bin/codium" \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" \
    "/usr/share/code/bin/code" \
    "/usr/share/code-insiders/bin/code-insiders" \
    "/usr/share/codium/bin/codium" \
    "/usr/bin/code" \
    "/usr/local/bin/code" \
    "/opt/visual-studio-code/bin/code" \
    "/opt/vscode/bin/code" \
    "/snap/bin/code" \
    "/snap/bin/code-insiders" \
    "/snap/bin/codium" \
    "/var/lib/flatpak/exports/bin/com.visualstudio.code" \
    "$HOME/.local/share/flatpak/exports/bin/com.visualstudio.code" \
    "/var/lib/flatpak/exports/bin/com.vscodium.codium" \
    "$HOME/.local/share/flatpak/exports/bin/com.vscodium.codium" \
    "$HOME/.local/bin/code"
  do
    [ -x "$bundled" ] && { printf '%s' "$bundled"; return 0; }
  done

  return 1
}

# Claude Code installed from the VS Code marketplace ships its own binary inside
# the extension directory and puts nothing on PATH. Someone with a working
# Claude in the next pane would otherwise be told they do not have one, which is
# the most confusing way this can fail.
find_claude() {
  command -v claude >/dev/null 2>&1 && { command -v claude; return 0; }

  local p
  for p in \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    "$HOME/.npm-global/bin/claude" \
    "/usr/local/bin/claude" \
    "/opt/homebrew/bin/claude" \
    "/usr/bin/claude"
  do
    [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  done

  local dir
  for dir in "$HOME/.vscode/extensions" "$HOME/.vscode-server/extensions" \
             "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" \
             "$HOME/.windsurf/extensions" "$HOME/.vscode-oss/extensions"
  do
    [ -d "$dir" ] || continue
    for p in $(ls -d "$dir"/anthropic.claude-code-* 2>/dev/null | sort -r); do
      [ -x "$p/resources/native-binary/claude" ] && {
        printf '%s' "$p/resources/native-binary/claude"; return 0;
      }
    done
  done

  return 1
}

# ── go ────────────────────────────────────────────────────────────────────
say ""
say "${BOLD}CR-Track${OFF} ${DIM}— reviews every commit with Claude${OFF}"
say ""

case "$BASE" in
  *REPLACE_WITH_R2_HOST*) die "This script was not configured with a download host." ;;
esac

step "Looking for VS Code"
CODE="$(find_code)" || die "VS Code was not found.
         If it is installed, open it and run:
           ${MOD}+Shift+P → 'Shell Command: Install code command in PATH'
         Then run this installer again. Or point at it directly:
           CODE_BIN=/path/to/code curl -fsSL $BASE/install.sh | bash"
say "    ${DIM}$CODE${OFF}"

step "Checking for the latest version"
REMOTE_VERSION="$(curl -fsSL "$BASE/version.txt" 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$REMOTE_VERSION" ] || die "Could not reach $BASE — check your connection."
say "    ${DIM}$REMOTE_VERSION${OFF}"

INSTALLED="$("$CODE" --list-extensions --show-versions 2>/dev/null | sed -n 's/^ikonic\.cr-track@//p' || true)"
if [ "$INSTALLED" = "$REMOTE_VERSION" ] && [ "${CR_TRACK_FORCE:-0}" != "1" ]; then
  say ""
  say "${GREEN}Already up to date${OFF} (${REMOTE_VERSION})."
  say "${DIM}Reinstall anyway with:  CR_TRACK_FORCE=1 curl -fsSL $BASE/install.sh | bash${OFF}"
  say ""
  exit 0
fi

step "Downloading"
TMP="$(mktemp -d)"
VSIX="$TMP/cr-track-${REMOTE_VERSION}.vsix"
curl -fsSL --retry 3 --retry-delay 1 -o "$VSIX" "$BASE/cr-track-latest.vsix" \
  || die "Download failed from $BASE/cr-track-latest.vsix"

# A .vsix is a zip. Anything else means we fetched an error page, and handing
# that to VS Code produces a baffling failure several steps later.
head -c 2 "$VSIX" | grep -q 'PK' || die "The downloaded file is not a valid .vsix."
say "    ${DIM}$(wc -c < "$VSIX" | tr -d ' ') bytes${OFF}"

step "Installing"
"$CODE" --install-extension "$VSIX" --force >/dev/null 2>&1 \
  || die "VS Code refused the extension. Try manually:
           $CODE --install-extension $VSIX --force"

NOW="$("$CODE" --list-extensions --show-versions 2>/dev/null | sed -n 's/^ikonic\.cr-track@//p' || true)"
[ -n "$NOW" ] || die "The extension does not appear installed. Try manually:
           $CODE --install-extension $VSIX --force"

say ""
say "${GREEN}Installed${OFF} CR-Track ${NOW}"

# ── the dependency people forget ──────────────────────────────────────────
CLAUDE="$(find_claude || true)"
if [ -n "$CLAUDE" ]; then
  say "${DIM}Claude CLI $("$CLAUDE" --version 2>/dev/null | head -1)${OFF}"
  case "$CLAUDE" in
    */extensions/*) say "${DIM}  found inside the Claude Code editor extension${OFF}" ;;
  esac
else
  warn "the Claude CLI was not found. CR-Track needs it to review anything,
           and stays inactive without it:

           npm i -g @anthropic-ai/claude-code
           claude          # sign in once"
fi

say ""
say "${BOLD}Next:${OFF} reload VS Code, then commit something."
say "  ${DIM}${MOD}+Shift+P → Developer: Reload Window${OFF}"
say "  ${DIM}Then set your ingest token: the key icon in the Findings panel,${OFF}"
say "  ${DIM}or ${MOD}+Shift+P -> CR-Track: Set ingest token.${OFF}"
say ""
