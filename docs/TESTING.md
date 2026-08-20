# CR-Track — tester's guide

CR-Track reviews each commit with Claude. Findings appear as squiggles and in a
panel; a record of every review goes to the dashboard.

**About 10 minutes.** The review runs on your machine; only a redacted report
leaves it.

---

## Setup

### 1. Claude CLI — required

CR-Track drives the CLI as a child process. Without it the extension installs
fine and does nothing (it says so in its log, but it will look broken).

```bash
claude --version        # need 2.0.0 or newer
```

Nothing? Install and sign in once:

```bash
npm i -g @anthropic-ai/claude-code
claude
```

> Reviews bill to **your own** Claude account.

> On Windows the installer often lands in `%USERPROFILE%\.local\bin`, which is
> **not on PATH** — so `claude` may fail in a terminal while the extension still
> finds it. That is expected; the extension searches known locations too.

### 2. Remove any older CR-Track first

Versions before 0.4.0 could leave `claude` processes running, and Windows then
refuses to delete the extension folder. If an uninstall ever failed for you:

```powershell
Get-Process claude -ErrorAction SilentlyContinue | Stop-Process -Force
```

Close VS Code, run that, then uninstall. 0.4.0 kills its own children, so this
is a one-time cleanup.

### 3. Install

```bash
code --install-extension cr-track-0.4.0.vsix
```

Or: Extensions panel → `···` menu → **Install from VSIX…**

Then **Ctrl+Shift+P → Developer: Reload Window**.

### 4. Confirm it started

**Ctrl+Shift+P → CR-Track: Show Log**. A healthy start reads:

```
Git 2.x.x at git
Claude CLI 2.1.x at …\claude.exe
Guides: …\resources\references
Watching for commits in …
Active on <your-repo> (<branch>) — every new commit will be reviewed
```

If any of those lines is missing, run **CR-Track: Diagnose** and send the
output — it prints every precondition in one go.

---

## Test it

Use a scratch branch of a real repo.

### A · A commit triggers a review

1. Edit a source file — ideally introduce something genuinely wrong.
2. Commit it, however you normally do.

**Expect:** within a couple of seconds the status bar (bottom left) shows
**CR-Track reviewing…**, then a count like **CR-Track 4**. Typically 20–60
seconds. You can keep working throughout; nothing blocks, and the commit has
already happened.

### B · The Findings panel

Click the **shield icon** in the left activity bar.

**Expect:** a tree of folders → files → findings, each showing a title and
`blocking · line 42`. Hover for the full description and the suggested fix.
Click a row to jump to the line.

Check: does the severity look right? Are the findings *real*, or noise?

### C · Squiggles

Open a file that has findings.

**Expect:** coloured underlines on the reported lines, and entries in the
Problems panel (**Ctrl+Shift+M**) tagged `cr-track`.

### D · It ignores what it should ignore

Each of these should produce **no** review. The log says why.

1. Commit a change to a `.md` file only → *touches no source files*.
2. Switch branches (`git checkout -b scratch`) → *not a commit, ignoring*.
3. Merge a branch with `--no-ff` → skipped.

### E · The dashboard

Open <https://cr-track-dashboard.vercel.app>.

**Expect:** your commit at the top within a few seconds of the review
finishing — your name, the repository and branch, the commit message, the
number of files and lines, and the findings by severity. Click the row to read
the full findings.

If it is not there, check the log for `Report sent to the dashboard (200)`. A
line saying *queued for retry* means the dashboard was unreachable; the report
is safe on disk and will be sent on the next activation.

### F · It fails safely

Rename your Claude CLI temporarily, reload the window.

**Expect:** the status bar reads **inactive** with an explanatory tooltip and
**one** notification. **Committing still works normally.** Put the CLI back
afterwards; the extension picks it up when the window regains focus.

### G · Uninstall

Extensions panel → CR-Track → **Uninstall**.

**Expect:** it uninstalls without an error about files in use. This is the bug
0.4.0 fixes, so it is worth doing deliberately rather than assuming.

---

## What I need back

For anything wrong, the log is the most useful thing:
**Ctrl+Shift+P → CR-Track: Show Log** → copy all. Add **CR-Track: Diagnose**
output if it looked inactive.

Worth reporting either way:

- **Finding quality.** Were they real problems, or noise? Roughly how many of
  each? This is the number that decides whether the tool is worth keeping.
- Anything that looked broken, ugly, or confusing.
- Anything that made you want to turn it off.

---

## Known limitations

Stated up front so they are not surprises.

- **Reviews take 20–60s** on a typical commit, longer on big ones. It runs after
  the commit, so you never wait for it.
- **Merges are not reviewed.** A merge's diff is everything both branches did.
- **Documentation, JSON, YAML, lockfiles and generated files are not reviewed.**
- **Only the most recent commit is reviewed.** Committing twice in quick
  succession while a review is running skips the second one; the log says so.
- **Findings are advisory.** Nothing is blocked and nothing is auto-fixed.
- **UI is thinly proven.** Logic and data flow are covered by 39 automated
  checks plus a live end-to-end against the real dashboard, but icon rendering,
  squiggle painting and menu placement have only been seen on one machine.

## Settings worth knowing

**Ctrl+,** → search `crTrack`.

| Setting | Try changing it if |
|---|---|
| `crTrack.effort` | Too slow (`low`) or too shallow (`high`) |
| `crTrack.profile` | Too noisy (`chill`) or too quiet (`assertive`) |
| `crTrack.minSeverity` | You only care about real problems (`important`) |
| `crTrack.endpoint` | You want reports somewhere else, or nowhere (clear it) |
| `crTrack.enabled` | You want it off without uninstalling |

## Uninstalling

Extensions panel → CR-Track → **Uninstall**. It leaves nothing behind except any
`.cr-track/` folder in repos it reviewed, which is safe to delete.
