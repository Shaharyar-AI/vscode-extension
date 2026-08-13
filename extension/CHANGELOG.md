# Changelog

## 0.3.0

**Setup now explains itself instead of failing quietly.**

- A **setup walkthrough** opens by itself the first time the extension is
  installed, with a live tick against each precondition — Claude CLI, then
  optionally a git repository — and a button to re-check.
- **Readiness is logged on every start**, so the first line of the log answers
  "is this thing set up?" without anyone guessing.
- A machine that is missing something gets **one** notification with the fix, on
  first install only. A working install stays silent.
- New commands: **Check Setup** and **Open Setup Guide**.
- A `crTrack.claudePath` that cannot be used is now reported rather than
  silently ignored. It still falls back to a working CLI — refusing to run
  because of a stale setting would be worse — but the setting no longer appears
  to do nothing.

## 0.2.0

**CR-Track no longer needs a git repository to be useful.**

- **Review any file or folder, repository or not.** Right-click in the Explorer,
  right-click in the editor, or use the panel. This is the answer to a folder
  that was never `git init`-ed: staged review and the commit gate still need a
  repository, everything else no longer does.
- The status bar distinguishes *files only* from *inactive*, because reporting a
  partial capability as death is how a working tool gets written off.

Fixes found by an internal audit, all of which could bite a colleague's machine
before they bit ours:

- **`git.path` set to an array crashed activation.** VS Code documents that
  setting as string, null *or* array, and an array threw
  `path.trim is not a function` straight out of activation — frozen status bar,
  empty log.
- **Diagnose broke the session it was diagnosing.** It reset the git path
  discovery had found, then reported a healthy repository as missing and left
  every later git call failing. The one command a confused user is told to run.
- **A `git init` could be missed forever.** The recovery throttle discarded
  triggers instead of deferring them, and `.git/HEAD` is created exactly once.
- **Review & Commit committed silently when inactive**, letting you believe a
  review had happened.

## 0.1.5

- **Fixed a runaway recheck loop.** Recovery throttled only the window-focus
  trigger, so the file watcher could restart the extension without limit. A
  folder that genuinely is not a repository repeated the same three log lines
  forever. All triggers are now throttled together, overlapping starts are
  prevented, and a dormant reason is logged once rather than on every recheck.
- **"Not a git repository" is now actionable.** The panel offers **Initialise a
  repository here**, and the log explains that a `.gitignore` alone does not
  make a folder a repository.

## 0.1.4

Hardening pass. Every failure reported from a real machine so far has been
environmental, so this release stops assuming a tidy one.

- **Git is found even when it is not on PATH.** CR-Track now checks
  `crTrack.gitPath`, then VS Code's `git.path`, then PATH, then the locations
  git actually installs to — including the copy bundled with GitHub Desktop.
  A window whose PATH lacks git no longer reports "not a git repository".
- **Dubious ownership offers a fix.** Git refuses repositories owned by another
  user account, common on a second drive. CR-Track now recognises it and offers
  **Trust this folder** rather than reporting a dead end.
- **Everything is reachable when the activity-bar icon is hidden.** The status
  bar reads *inactive* and opens a menu with review, panel, diagnose, restart,
  log and settings.
- Added a `crTrack.gitPath` setting.

## 0.1.3

- **"Not a git repository" was reported for problems that were nothing of the
  kind.** Any failure of `git rev-parse` produced that one message, so a window
  that did not inherit git on its PATH, or a repository tripping Windows'
  dubious-ownership check, was told its folder had no `.git`. The three cases
  are now distinguished and git's own words are logged.
- VS Code's `git.path` setting is honoured, so CR-Track finds git wherever
  Source Control already found it.
- Added **CR-Track: Diagnose**, which prints folder, git binary, repository
  status, CLI version, guides, model and endpoint in one go.

## 0.1.2

- **The extension no longer stays stuck once it goes dormant.** It checked for a
  git repository and the Claude CLI exactly once at startup, so running
  `git init` — or installing the CLI — afterwards did nothing until the window
  was reloaded, which looked identical to the extension being broken. It now
  watches for a repository appearing and rechecks when the window regains focus.
- Added **CR-Track: Restart** for a manual recheck.
- Asking for a review while inactive now retries the startup checks first,
  instead of only reporting that it is inactive.

## 0.1.1

- **"Nothing staged" is now visible rather than silent.** With changes in the
  working tree but nothing staged, the extension looked identical to broken: an
  empty panel and no explanation. The status bar now reads *nothing staged*, the
  panel says why, and the log records it.
- Added **CR-Track: Review Working Tree**, which reviews staged and unstaged
  changes together, for anyone who does not stage incrementally.

## 0.1.0

First release.

- Reviews staged changes automatically, two seconds after the git index settles,
  so the result is usually ready before you press commit.
- Findings appear as editor squiggles and in a dedicated Findings panel grouped
  by folder and file, with accept and reject on each row.
- Accept applies a patch and is offered only where Claude supplied one. The
  current file is checked against what was reviewed first, so a patch is never
  applied to lines that have moved.
- Reject records a reason, which goes into the report.
- **Review & Commit** asks before committing over a blocking finding and always
  offers a way through.
- Every review writes `.cr-track/last-review.json`, and POSTs it when the
  repository configures an `endpoint`. Secrets are stripped first; a failed
  upload queues and retries and can never interrupt a commit.
- Language guides for TypeScript, JavaScript, Python and Go, plus always-on
  architecture, security and performance guides.
- Missing or outdated Claude CLI parks the extension as dormant with one
  notification rather than failing repeatedly.
