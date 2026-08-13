# Changelog

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
