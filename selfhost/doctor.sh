#!/usr/bin/env bash
#
# CR-Track doctor — answers "why does it say inactive?"
#
#   curl -fsSL https://<host>/doctor.sh | bash
#
# Checks every precondition the extension checks, in the same order, and prints
# the fix for whichever one fails. Read-only: it changes nothing.

set -uo pipefail
# Cmd on macOS, Ctrl on Linux. One script serves both, and the palette shortcut
# is the first instruction a new developer is given — printing the wrong one
# reads as a script written for somebody else's machine.
case "$(uname -s 2>/dev/null || echo Linux)" in
  Darwin) MOD="Cmd" ;;
  *)      MOD="Ctrl" ;;
esac

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""
fi

ok()   { printf '  %sok  %s %s\n' "$GREEN" "$OFF" "$*"; }
no()   { printf '  %sFAIL%s %s\n' "$RED" "$OFF" "$*"; PROBLEMS=$((PROBLEMS+1)); }
hm()   { printf '  %swarn%s %s\n' "$YELLOW" "$OFF" "$*"; }
note() { printf '       %s%s%s\n' "$DIM" "$*" "$OFF"; }

PROBLEMS=0
printf '\n%sCR-Track doctor%s\n\n' "$BOLD" "$OFF"

# ── 1. the editor ─────────────────────────────────────────────────────────
printf '%sVS Code%s\n' "$BOLD" "$OFF"
CODE=""
for c in code code-insiders cursor windsurf codium; do
  command -v "$c" >/dev/null 2>&1 && { CODE="$c"; break; }
done
if [ -z "$CODE" ]; then
  for b in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/usr/share/code/bin/code" \
    "/usr/share/code-insiders/bin/code-insiders" \
    "/usr/share/codium/bin/codium" \
    "/usr/bin/code" \
    "/opt/visual-studio-code/bin/code" \
    "/snap/bin/code" \
    "/snap/bin/codium" \
    "/var/lib/flatpak/exports/bin/com.visualstudio.code" \
    "$HOME/.local/share/flatpak/exports/bin/com.visualstudio.code"
  do
    [ -x "$b" ] && { CODE="$b"; break; }
  done
fi

if [ -n "$CODE" ]; then
  ok "found: $CODE"
  INSTALLED="$("$CODE" --list-extensions --show-versions 2>/dev/null | sed -n 's/^ikonic\.cr-track@//p')"
  if [ -n "$INSTALLED" ]; then
    ok "CR-Track $INSTALLED is installed"
  else
    no "CR-Track is not installed in this editor"
  fi
else
  no "no VS Code CLI found on PATH"
  note "VS Code → ${MOD}+Shift+P → 'Shell Command: Install code command in PATH'"
fi

# ── 2. the Claude CLI ─────────────────────────────────────────────────────
printf '\n%sClaude CLI%s   %s(the usual cause of \"inactive\")%s\n' "$BOLD" "$OFF" "$DIM" "$OFF"
CLAUDE="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE" ]; then
  for p in \
    "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
    /usr/local/bin/claude /opt/homebrew/bin/claude \
    "$HOME/.volta/bin/claude" "$HOME/.asdf/shims/claude" "$HOME/.bun/bin/claude"
  do
    [ -x "$p" ] && { CLAUDE="$p"; break; }
  done
  if [ -z "$CLAUDE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    CLAUDE="$(find "$HOME/.nvm/versions/node" -maxdepth 3 -name claude -type f 2>/dev/null | tail -1)"
  fi
  # Last: the copy bundled inside the Claude Code editor extension, which puts
  # nothing on PATH. This is the commonest reason someone insists they have
  # Claude while every lookup above disagrees.
  if [ -z "$CLAUDE" ]; then
    for d in "$HOME/.vscode/extensions" "$HOME/.vscode-server/extensions" \
             "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" \
             "$HOME/.windsurf/extensions" "$HOME/.vscode-oss/extensions"
    do
      [ -d "$d" ] || continue
      for e in $(ls -d "$d"/anthropic.claude-code-* 2>/dev/null | sort -r); do
        if [ -x "$e/resources/native-binary/claude" ]; then
          CLAUDE="$e/resources/native-binary/claude"
          CLAUDE_SOURCE="the Claude Code editor extension"
          break 2
        fi
      done
    done
  fi
fi

if [ -n "$CLAUDE" ]; then
  VER="$("$CLAUDE" --version 2>/dev/null | head -1)"
  if [ -n "$VER" ]; then
    ok "$CLAUDE"
    ok "reports: $VER"
  else
    no "$CLAUDE exists but did not answer --version"
    note "Run it yourself: $CLAUDE --version"
  fi
else
  no "no claude binary found anywhere this script looked"
  note "Install:  npm i -g @anthropic-ai/claude-code   then:  claude"
fi

# ── 3. the PATH trap ──────────────────────────────────────────────────────
# This is the failure that makes people insist the extension is broken: the CLI
# works in their terminal and is invisible to an editor launched from the Dock.
if [ -n "$CLAUDE" ]; then
  printf '\n%sPATH visibility%s\n' "$BOLD" "$OFF"
  CLAUDE_DIR="$(dirname "$CLAUDE")"
  case ":$PATH:" in
    *":$CLAUDE_DIR:"*) ok "$CLAUDE_DIR is on PATH in this shell" ;;
    *) hm "$CLAUDE_DIR is NOT on PATH in this shell" ;;
  esac
  case "$CLAUDE" in
    *"/.nvm/"*|*"/fnm/"*|*"/.asdf/"*|*"/.volta/"*)
      hm "the CLI comes from a Node version manager"
      note "Editors launched from the Dock do not inherit that PATH."
      note "CR-Track 0.4.1+ searches these locations and asks your login shell."
      note "If you are on an older build, set this in VS Code settings:"
      note "  \"crTrack.claudePath\": \"$CLAUDE\""
      ;;
    *) ok "the CLI is in a location editors can find" ;;
  esac
fi

# ── 4. git and a repository ───────────────────────────────────────────────
printf '\n%sGit%s\n' "$BOLD" "$OFF"
if command -v git >/dev/null 2>&1; then
  ok "$(command -v git) — $(git --version 2>/dev/null)"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ok "this folder is a git repository"
    if git rev-parse HEAD >/dev/null 2>&1; then
      ok "it has commits ($(git rev-parse --short HEAD))"
    else
      hm "no commits yet — the first one will be reviewed"
    fi
  else
    hm "you are not inside a git repository right now"
    note "CR-Track only activates on a folder that is one. Run this from your project."
  fi
else
  no "git is not on PATH"
fi

# ── verdict ───────────────────────────────────────────────────────────────
printf '\n'
if [ "$PROBLEMS" -eq 0 ]; then
  printf '%sNothing blocking found.%s\n' "$GREEN" "$OFF"
  note "If it still says inactive: open the project folder in VS Code, then"
  note "${MOD}+Shift+P → 'CR-Track: Diagnose' and send that output."
else
  printf '%s%s problem(s) above.%s Fix those, then reload VS Code.\n' "$RED" "$PROBLEMS" "$OFF"
fi
printf '\n'
