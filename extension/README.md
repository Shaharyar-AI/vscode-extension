# CR-Track

Reviews every commit with Claude, tells the developer what to improve, and
reports the result to your dashboard.

You commit as normal. A few seconds later CR-Track has read the diff, and if
anything is worth saying it appears as squiggles in the editor and rows in the
Findings panel. A clean commit produces silence. Either way, a record goes to
the dashboard.

It never blocks a commit and never interrupts you — the commit has already
happened by the time it runs.

## Requirements

**The [Claude CLI](https://claude.com/claude-code) must be installed and signed
in.** CR-Track drives it as a short-lived child process, so reviews bill to your
own Claude account. Without it the extension stays dormant and says why.

```bash
npm i -g @anthropic-ai/claude-code
claude          # sign in once
```

Version 2.0.0 or newer. Git must be installed; CR-Track finds it on `PATH`, via
VS Code's `git.path`, or in the usual install locations.

## Using it

There is nothing to run. Open a git repository and commit. That is the whole
interface.

- The status bar shows **Reviewing commit abc1234**, then a count.
- The shield icon in the activity bar opens the Findings panel. Hover a row for
  the full explanation and the suggested fix; click it to jump to the line.
- Findings also appear in the Problems panel.

Commits that cannot say anything useful about a developer's work are skipped:
merges, and commits that touch no source files (documentation, lockfiles,
generated output).

If you want to re-run the last one by hand: **CR-Track: Review the Last Commit**.

## The dashboard

Every review is written to `.cr-track/last-review.json` and POSTed to the
endpoint. If the endpoint is unreachable the report queues under
`.cr-track/queue/` and retries later — a dashboard being down never costs you a
review.

The default endpoint is the CR-Track dashboard at
<https://cr-track-dashboard.vercel.app>. Change it in **Settings →
`crTrack.endpoint`**, or per repository with a `.cr-track.yaml` at the root:

```yaml
endpoint: https://your-dashboard.example.com/api/ingest
profile: balanced
min_severity_to_report: nit
model: claude-opus-5
effort: medium
```

The file wins over the setting, so a team gets the same review wherever they
work. Clear the setting to keep reports on disk only.

Secrets are stripped from every report before it leaves the machine — API keys,
tokens and passwords are redacted after the model has written its findings, not
before.

## Severities

| | Meaning |
|---|---|
| **blocking** | A vulnerability, data loss, or a bug that will show up in production |
| **important** | A likely bug or risky pattern |
| **nit** | Style, naming, minor maintainability |
| **suggestion** | Worth considering, safe to ignore |

`crTrack.profile` sets how much gets reported: `chill` (blocking and clear
important findings only), `balanced`, or `assertive` (everything).

## When nothing happens

Run **CR-Track: Diagnose** from the Command Palette. It prints, in one go: the
folder, which git binary was found, whether the folder is a repository, which
Claude CLI was found and its version, where the review guides came from, the
dashboard endpoint, and the model settings. The first line that says `NO` is the
problem.

Common causes:

- **No git repository.** CR-Track has nothing to watch. Run `git init`, and it
  picks the repository up without a reload.
- **Claude CLI not installed or not signed in.** The status bar reads
  *inactive*; Diagnose names it.
- **Nothing committed yet.** It triggers on commits, not on saves or staging.

## Settings

| Setting | Default | |
|---|---|---|
| `crTrack.enabled` | `true` | Review each commit automatically |
| `crTrack.endpoint` | CR-Track dashboard | Where reports are sent |
| `crTrack.model` | `claude-opus-5` | Model to review with |
| `crTrack.effort` | `medium` | Reasoning effort |
| `crTrack.profile` | `balanced` | How strict the reviewer is |
| `crTrack.minSeverity` | `nit` | Drop findings below this |
| `crTrack.timeoutSeconds` | `300` | Abandon a review that runs longer |
| `crTrack.claudePath` | auto | Absolute path to the Claude CLI |
| `crTrack.gitPath` | auto | Absolute path to git |
