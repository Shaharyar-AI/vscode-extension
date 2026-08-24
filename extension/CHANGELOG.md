# Changelog

## 0.9.1

Fixes whole-file review, which 0.9.0 broke.

- 0.9.0 ruled out "anything this diff did not introduce", which is right for a
  commit and wrong for a whole-file review: nothing is introduced there, so the
  rule suppressed every finding and the review came back empty. Whole-file mode
  now says so explicitly — defects already present in the files are in scope,
  because the files are the subject.

## 0.9.0

Setting your token is a button now, and it tells you straight away whether it
works.

- **A key icon in the Findings panel title bar**, beside review and copy-all.
  Setting a token is the one thing every developer must do by hand, and until
  they do it every report is refused — leaving it in the command palette cost a
  support conversation per person.
- **The token is checked as you enter it.** Accepted, rejected, or "could not
  reach the dashboard", said immediately rather than discovered at the next
  commit when the dashboard turns out to be empty.
- The check writes nothing. It sends a payload the server must reject, because
  authentication is tested before the schema: a 422 proves the credentials were
  accepted while storing nothing. Sending a valid probe would have answered the
  same question by filing a junk review for every developer who ever set a
  token.

## 0.9.0

Defects only, and the dashboard now learns what you did about them.

**Reviews report defects, not opinions.**

- Findings are limited to **security, correctness and performance**.
  Maintainability, testing, style and docs are no longer findings at all. A
  six-line diff was returning nine findings — none of them defects, two rated at
  the severity that feeds the author's performance measure. An opinion that
  costs someone a KPI point is worse than no finding.
- An explicit **"what is NOT a finding"** list, and **pre-existing problems in
  surrounding code are out of scope** — that drift is what turned small diffs
  into long reviews.
- Every finding must name **what breaks, the trigger, the file and line, and one
  concrete fix**. No "consider reviewing this logic".
- The **high-level architecture pass is gone**, and the architecture guide is no
  longer assembled: both existed to produce design commentary.
- **A 0.8 confidence floor, enforced in the extension** rather than only asked
  for in the prompt, at every severity including blocking. Configurable via
  `crTrack.minConfidence`.

**The outcome is pushed back, so the KPI can be computed.**

- Reports are `schemaVersion` **2.1** and carry **`finalized`**. A report sent
  when the review completes always reads 0% applied, because nobody has fixed
  anything yet — consumers hold it out of scoring until it is finalized.
- Ticking a finding **updates that review in place**, under the same
  `review.id`, with stable finding ids so the history of what was raised and
  then fixed survives. Debounced, so working through a list is one upload.
- `finalized` is set when **every finding has been dealt with**, and when **the
  next commit closes the review out** — whatever the developer did or did not do
  about it. Without that second trigger, a review nobody touched would stay
  unscored for ever.

**Setting your token is a button.**

- A key icon in the Findings panel title bar, beside review and copy-all.
- The token is **checked as you type it** — accepted, rejected, or dashboard
  unreachable — instead of failing silently at your next commit. The check
  stores nothing: it sends a payload the server must reject, so a 422 proves the
  credentials passed while filing no review.

## 0.8.0

The reviewer can say something good, and is told to quote less.

- **Annotations work.** The prompt said "Return findings ONLY", which
  contradicted the rule set's `learning` and `praise` notes — so the model never
  emitted one. The prompt now asks for them explicitly, in their own array.
- That alone would have changed nothing: the extension passed a hardcoded empty
  array into the report and discarded whatever the reviewer returned. Both ends
  are fixed, so the notes now reach the dashboard.
- **Quoting is bounded.** A finding should quote a line or two to make its
  point, not paste back a whole function — descriptions and suggestions leave
  the machine and are stored server-side. Customer data, personal data and
  credentials must never be reproduced, even to illustrate the problem.
- `docs/PROMPT.md` is generated from the engine's own builder (`npm run
  prompt-doc`), so what is documented is what the model receives.

## 0.7.1

Reports now go to the team's tracker.

- `crTrack.endpoint` defaults to `https://ikonictracker.demosites.cc/api/ingest`.
  Verified end to end: a real commit, reviewed by Claude, accepted with a 200.
- **Reporting there needs a personal token.** Run **CR-Track: Set ingest token**
  once with the token minted for you. Without it every report is refused and the
  extension says so — reviews still run and are kept locally, but nothing is
  recorded against you.
- A repository's `.cr-track.yaml` still overrides the setting, and clearing the
  setting keeps reports on disk only.

## 0.7.0

Two bugs in 0.6.0's green ticks, and the groundwork for reporting to a dashboard
that authenticates.

- **Ticking one finding could turn a different one green.** Every review numbers
  its findings from `f1`, so findings carried over from the previous commit
  arrived holding ids this commit's findings had already taken. Everything keys
  on id — the fixed set, the squiggle removal, the saved progress — so the marks
  landed on whatever happened to share the id. Ids are now made unique at the
  one point the two sets meet, and a confirmed fix follows its own finding
  through the renaming.
- **Findings carried over from an earlier commit vanished on reload.** The panel
  was restored from `last-review.json`, which describes one commit by design.
  Panel state is now saved separately in `.cr-track/panel.json` — what was on
  screen, and which rows were ticked. The report keeps describing only its own
  commit, so nothing carried forward inflates the counts a review is judged on.

Reporting to an authenticated dashboard:

- **`CR-Track: Set ingest token`** stores a personal token in VS Code's secret
  storage. Not a setting: `settings.json` is committed, shared and synced
  between machines, and these tokens identify one person.
  `CR_TRACK_INGEST_TOKEN` still works for CI.
- **A rejected token or a malformed payload is no longer queued.** Both fail
  identically however many times they are retried, so queueing them buried a
  problem only a person could fix and filled the queue with work that could
  never drain. A 401 now says the token is the problem and offers to fix it; a
  422 logs every reason the server gave. A dashboard that is merely down still
  queues, which is what the queue is for.
- `repository.repo` is now qualified by its owner (`org/repo`), which a bare
  name is not once two organisations both have a "backend".

## 0.6.0

Fixing a problem now marks it fixed.

- **A finding turns green when the reviewer confirms the fix.** After each
  commit the outstanding findings go back to Claude with the new diff and the
  question "which of these does this actually fix?". Confirmed ones turn green
  and read `fixed - confirmed`; everything else carries forward unchanged.
- **Silence is never treated as success.** A review sees a diff, not a whole
  file, so a problem can go unmentioned simply because nobody looked at it. Only
  an explicit confirmation turns a row green - being unsure leaves it open,
  because telling someone a bug is fixed when it is not is the one failure that
  actually costs them something.
- Findings now survive the commit that fixed them instead of vanishing, so you
  can see what you have dealt with, not only what is left.

Fixes found by CR-Track reviewing its own 0.5.0 release:

- A malformed `last-review.json` threw out of startup and stopped the extension
  activating at all. Reports are shape-checked now, and restoring can never take
  activation down with it.
- Progress pruning evicted by first-insertion order and could discard the entry
  it had just written.
- `revealFinding` kept its own copy of the node-unwrapping logic. Clicking a
  finding now has a test, which it never had before.

## 0.5.0

Working through the findings, rather than just reading them.

- **Copy** on every finding — file, line, severity, the description and the
  suggestion, formatted to paste straight into an assistant. **Copy all** in the
  panel header does the outstanding ones in one go, and skips what is done.
- **Mark as fixed** turns the row green, drops its squiggle, and leaves the rest
  open so the next one to pick up is obvious. The title counts progress
  (`Findings (2/8 fixed)`) and the badge counts what is *left*, not what was
  found — a number that never moves as you work is only decoration.
- Marks are made by hand. An edit does not prove a problem was solved, and a row
  that turned green on its own would be a claim the extension cannot support.
- **The panel survives a window reload.** Previously it was empty after every
  restart until the next commit, so a half-finished list disappeared. The last
  review is restored from `.cr-track/last-review.json`, green ticks included.

## 0.4.3

**Finds Claude when it lives inside the Claude Code editor extension.**

The reported case, and the one the previous two fixes both missed. Installing
Claude Code from the VS Code marketplace gives you a working Claude terminal and
no `claude` on PATH at all — the binary ships inside the extension directory, at
`~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude`.
Everywhere CR-Track looked was a place a *CLI install* puts it, so it reported
"no Claude CLI" to someone who could see Claude working in the next pane.

- **Editor-bundled binaries are searched first**, across VS Code, Insiders,
  Cursor, Windsurf, VSCodium and remote/server installs, newest version first.
  First rather than last on purpose: if the editor ships a Claude, that is the
  one the developer is actually using.
- **The version probe now allows 60 seconds, not 15.** The code's own comment
  said a cold Windows machine takes 20+ seconds — so on exactly those machines
  every candidate timed out and the CLI was reported missing. That alone could
  produce this symptom with a perfectly normal install.
- **Every rejected candidate is logged with the reason.** A "not found" now
  names each path tried and what happened, instead of being an assertion the
  user has no way to argue with.
- **Caches expire.** A successful detection was remembered for the whole window
  lifetime; it now expires after ten minutes, so installing or upgrading Claude
  is picked up without a reload.
- **New command: "CR-Track: Re-detect Claude CLI and repositories"** — clears
  every cached answer and re-runs startup, then says what it found or offers the
  log and the setting.

## 0.4.2

**Watches every repository in the window, not just the first.**

Reported with a screenshot that made it unarguable: the status bar read
"CR-Track · not a git repo" while the Source Control panel beside it listed two
repositories. CR-Track only ever looked at `workspaceFolders[0]`, so a workspace
whose first folder is a plain parent directory — or a multi-root workspace whose
first folder happens not to be a repo — went dormant with git working perfectly.

- **Repositories are discovered from three sources**: every workspace folder,
  VS Code's own Git extension (authoritative for anything it has already found,
  including repositories nested inside a non-repo folder), and — only when those
  find nothing — a one-level scan for child directories containing `.git`.
- **One commit watcher per repository.** A commit in the second repository is
  reviewed, which it previously was not.
- **Reports are per repository.** Repository context is read fresh at review
  time rather than reused from activation, each repository's own
  `.cr-track.yaml` applies, and each has its own retry queue.
- **"Review the Last Commit" targets the repository you are editing**, not
  whichever sorted first, and says which one in the progress notification.
- **Diagnose lists them all** — every workspace folder and whether it is a repo,
  what the Git extension found, what was discovered, and what is being watched.

## 0.4.1

**Fixes "CR-Track is inactive" on a machine where the Claude CLI plainly works.**

Reported by a teammate on macOS, and the discovery logic was at fault. VS Code
launched from the Dock inherits a bare `PATH` — roughly `/usr/bin:/bin` — not the
one your shell builds from `.zshrc`. Anyone whose Node came from nvm, fnm, asdf
or Volta therefore had a `claude` that ran perfectly in a terminal and was
invisible to the extension. Restarting and toggling the setting could not
possibly help, which is exactly what makes it maddening.

- **Version-manager installs are now searched**: nvm, fnm and Volta node
  directories (newest version first), plus asdf shims, pnpm, yarn, Bun, Volta,
  `~/.npm-global` and `/usr/bin`.
- **The login shell is asked directly** when nothing else works — `$SHELL -lic
  'command -v claude'` — which is the only way to see a PATH the editor never
  inherited. Tried last, because starting a login shell is slow.
- **The status bar now names the cause**: "CR-Track · no Claude CLI",
  "· not a git repo", "· no folder open" — instead of a bare "inactive" whose
  reason was hidden in a tooltip nobody hovers.
- **The message says what to do**: if `claude` works in your terminal, run
  `which claude` and put that path in `crTrack.claudePath`.

## 0.4.0

**CR-Track now does one thing: it reviews your commits.**

The trigger was wrong. Earlier versions reviewed *staged* changes, so the review
fired on `git add` and had usually been forgotten by the time anyone committed —
and a developer who never stages incrementally saw nothing at all. It now
triggers on the commit itself, which is the event the dashboard measures and the
one developers actually notice.

- **Reviews the commit that just landed.** The reflog is watched for a new HEAD;
  the reflog action word distinguishes a commit from a checkout, reset or
  rebase, so switching branches no longer hands the model an enormous unrelated
  diff.
- **Merges are skipped.** A merge's diff is everything both branches did, which
  says nothing about what this developer wrote.
- **Documentation-only commits are skipped.** Markdown, JSON, YAML, lockfiles,
  `dist/`, `node_modules/` and generated files no longer consume a review.
- **The commit travels with the report** — sha, message, author and timestamp —
  so the dashboard can attribute a review without guessing from a branch name.
- **A dashboard is configured out of the box.** `crTrack.endpoint` now defaults
  to the CR-Track dashboard, so a fresh install reports without setup. A
  repository's `.cr-track.yaml` still overrides it.

**A spurious trigger no longer reviews old history.** Seen on a real machine
within minutes of installing this version: the watcher fired on a repository
whose HEAD had not moved, the starting HEAD had never been recorded, and CR-Track
reviewed a commit from the previous week. An unknown starting point is now
adopted rather than treated as new, an empty repository is told apart from git
failing to answer so a first-ever commit is still reviewed, and a commit whose
own timestamp is more than ten minutes old is refused outright.

**The uninstall failure is fixed.** Killing a review left its child processes
running: on Windows `SIGTERM` is advisory and there are no process groups, so
`claude.cmd`'s children survived, held handles inside the extension directory,
and Windows then refused to remove it. Every child is now tracked and killed as
a tree (`taskkill /T /F`), and closing the window kills anything still running.
Machines that hit this will have orphaned `claude` processes from earlier
versions; end those once, and it will not recur.

**Everything that was not the above is gone**: file and folder review, the
working-tree mode, the commit gate, accept/reject on findings, the setup
walkthrough and the seventeen commands that came with them. Each was one more
thing to be broken on someone else's machine, and none of them served the
trigger the product is about. Five commands remain: Review the Last Commit,
Clear Findings, Show Log, Diagnose, Go to Finding.

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
