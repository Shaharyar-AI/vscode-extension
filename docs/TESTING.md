# CR-Track — tester's guide

Reviews your staged changes with Claude before you commit. Findings appear as
squiggles and in a panel, each with accept and reject.

**About 15 minutes to work through.** Everything happens on your machine.

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

### 2. Install the extension

```bash
code --install-extension cr-track-0.1.0.vsix
```

Or: Extensions panel → `···` menu → **Install from VSIX…**

Then **Ctrl+Shift+P → Developer: Reload Window**.

### 3. Confirm it started

**Ctrl+Shift+P → CR-Track: Show Log**. A healthy start reads:

```
Guides: …\resources\references
Claude CLI 2.1.227 at …\claude.exe
Active on <your-repo> (<branch>)
```

If it says *Guides not found* or *Claude CLI not found* — stop and report that.

---

## Test it

Use a scratch branch of a real repo. Nothing is committed without you.

### A · A review happens

1. Edit a file — ideally introduce something genuinely wrong.
2. Stage it (`git add`, or `+` in Source Control).
3. Wait ~2 seconds.

**Expect:** status bar (bottom left) shows **Reviewing…** with a spinner, then a
count like **CR-Track 4**. Typically 20–60 seconds.

You should be able to keep typing throughout. **Nothing should block.**

### B · The Findings panel

Click the **shield icon** in the left activity bar.

**Expect:** a tree of folders → files → findings. Each finding shows a title and
`f1 · blocking · line 42 · 95%`. Hover for the full description, the suggestion,
and a preview of any patch.

Check: does the severity look right? Are the findings *real*, or noise?

### C · Squiggles

Open a file that has findings.

**Expect:** coloured underlines on the reported lines; entries in the Problems
panel (**Ctrl+Shift+M**) tagged `CR-Track`.

### D · Accept a fix

In the panel, hover a finding with a **✓** and click it.

**Expect:** the file changes, the row greys out and reads `applied`, the squiggle
disappears.

> **✓ only appears where Claude supplied a patch.** Findings like "these
> functions have no tests" show reject only — that is deliberate, not a bug.

### E · Reject

Click **✗** on any finding.

**Expect:** a prompt for a reason. Type one. The row reads `dismissed`.
Pressing Escape should cancel entirely, leaving the finding open.

### F · The staleness guard

1. Find a finding that still has a **✓**.
2. Add two blank lines at the **top** of that file and save.
3. Click **✓**.

**Expect:** a warning that the file changed since the review, and **the file is
not modified**. This is the guard against patching shifted lines.

### G · Commit gate

Click **Review & Commit** in the Source Control toolbar.

**Expect:** with blocking findings outstanding, a dialog listing them offering
**Review them** / **Commit anyway**. "Commit anyway" asks for a reason, then
commits. With no blockers it commits without asking.

### H · Fails safely

Rename your Claude CLI temporarily, reload the window.

**Expect:** the extension goes quiet with an explanatory tooltip and **one**
notification. **Committing still works normally.** Put the CLI back afterwards.

---

## What I need back

For anything wrong, the log is the most useful thing:
**Ctrl+Shift+P → CR-Track: Show Log** → copy all.

Worth reporting either way:

- **Finding quality.** Were they real problems, or noise? Roughly how many of
  each? This is the number that decides whether the tool is worth keeping.
- Anything that looked broken, ugly, or confusing.
- Anything that made you want to turn it off.

---

## Known limitations

Stated up front so they are not surprises.

- **Reviews take 20–60s** on a typical change, longer on big ones. It runs while
  you keep working, so you normally do not wait — but a commit right after
  staging can catch it mid-review.
- **Not every finding has a patch.** Anything needing new files, new imports
  elsewhere, or judgement is reported without a ✓.
- **Nothing is truly blocked.** VS Code gives extensions no pre-commit hook, so
  the gate is a prompt with an override, and `--no-verify` bypasses everything.
  This is advisory by design.
- **Reports are local unless configured.** Every review writes
  `.cr-track/last-review.json`. Nothing is uploaded unless a repo's
  `.cr-track.yaml` or the `crTrack.endpoint` setting names a dashboard.
- **UI is unproven in the wild.** Logic and data flow are covered by 44
  automated checks, but icon rendering, squiggle painting and menu placement
  have never been seen outside a test harness. That is largely what this pass
  is for.

## Settings worth knowing

**Ctrl+,** → search `crTrack`.

| Setting | Try changing it if |
|---|---|
| `crTrack.effort` | Too slow (`low`) or too shallow (`high`) |
| `crTrack.profile` | Too noisy (`chill`) or too quiet (`assertive`) |
| `crTrack.minSeverity` | You only care about real problems (`important`) |
| `crTrack.enabled` | You want it off without uninstalling |

## Uninstalling

Extensions panel → CR-Track → **Uninstall**. It leaves nothing behind except any
`.cr-track/` folder in repos it reviewed, which is safe to delete.
