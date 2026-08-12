# CR-Track

Reviews your staged changes with Claude before you commit.

Stage some files and CR-Track reviews them in the background while you carry on
working. Findings arrive as squiggles in the editor and rows in a dedicated
panel, each with accept and reject. Clean code produces silence.

## Requirements

**The [Claude CLI](https://claude.com/claude-code) must be installed and signed
in.** CR-Track drives it as a short-lived child process; reviews bill to your own
Claude account. Without it the extension stays dormant and tells you why — it
never blocks a commit.

```bash
npm i -g @anthropic-ai/claude-code
claude          # sign in once
```

Version 2.0.0 or newer.

## Using it

1. Stage changes — `git add`, or the `+` in Source Control.
2. Wait about two seconds. The status bar shows **Reviewing…**, then a count.
3. Open the shield icon in the activity bar for the Findings panel.
4. **Accept** applies the patch. **Reject** asks why and records it.
5. **Review & Commit** in the Source Control toolbar asks before shipping a
   blocking finding, and always lets you through with a reason.

Findings also appear as squiggles, with the same actions on `Ctrl+.`.

## Severities

| | Meaning |
|---|---|
| **blocking** | A vulnerability, data loss, or a bug that will show up in production |
| **important** | A likely bug or risky pattern |
| **nit** | Style, naming, minor maintainability |
| **suggestion** | Optional improvement |

Only **blocking** ever interrupts a commit, and only with an override available.

Accept appears only where Claude supplied an applicable patch. Findings like
"these functions have no tests" offer reject and copy-suggestion instead —
an Accept button that could not do anything would be misleading.

Before any patch is written, the current file is compared against what was
reviewed. If it changed underneath, the patch is refused rather than applied to
the wrong lines.

## Settings

| Setting | Default | |
|---|---|---|
| `crTrack.enabled` | `true` | Review automatically as you stage |
| `crTrack.claudePath` | auto | Set if the CLI is not discovered |
| `crTrack.model` | `claude-opus-5` | |
| `crTrack.effort` | `medium` | `low` … `max`; higher is slower and more thorough |
| `crTrack.profile` | `balanced` | `chill`, `balanced`, `assertive` |
| `crTrack.minSeverity` | `nit` | Hide anything below this |
| `crTrack.debounceMs` | `2000` | Settle time after staging |
| `crTrack.timeoutSeconds` | `300` | Abandon a review that runs longer |
| `crTrack.blockCommitOnBlocking` | `true` | Ask before committing over a blocker |

## Per-repository config

A `.cr-track.yaml` at the repo root sets the team's shared answer and overrides
personal settings, so everyone reviewing a repo gets the same review:

```yaml
profile: balanced
min_severity_to_report: nit
categories_enabled: [security, correctness, performance, maintainability, testing, style, docs]
endpoint: https://your-dashboard.example.com/api/ingest
```

## Reporting

Every review writes `.cr-track/last-review.json`. When `endpoint` is set it is
also POSTed there, with `CR_TRACK_INGEST_TOKEN` as a bearer token if that
environment variable exists.

Only metadata and one-line summaries leave your machine — never file contents,
never raw diffs. Secrets are stripped before anything is written or sent. A
failed upload queues on disk and retries later; it can never interrupt a commit.

## When something looks wrong

**CR-Track: Show Log** in the command palette. On a healthy start it reads:

```
Guides: …/resources/references
Claude CLI 2.1.227 at …/claude.exe
Active on <repo> (<branch>)
```

If it says *Guides not found*, reviews still run but without the ruleset, and
findings get noticeably weaker — worth reporting.

## Privacy

Your code is sent to Anthropic by the Claude CLI, under your own account and its
terms. CR-Track adds no telemetry of its own beyond the report described above,
and that only goes to an endpoint your repository configures.

## Licence

MIT
