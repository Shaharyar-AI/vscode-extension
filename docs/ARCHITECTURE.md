# CR-Track — Solution Architecture

VS Code extension that reviews each commit with Claude, shows the developer what
to improve, and reports the outcome to a dashboard.

## Guiding principle

> **The model judges code. Everything else is code.**

A prototype version of this asked the LLM to run git commands, assemble a
12-field JSON envelope, apply redaction regexes, POST a webhook, and
self-correct on HTTP 422. That is deterministic work being done
non-deterministically — slow, token-expensive, and it manufactures a consent
decision that then has to be argued away in the prompt.

Moving it into TypeScript removes the token cost, the retry loop, and the
argument.

## Shape

Everything runs on the developer's machine. The extension orchestrates; a
short-lived `claude -p` child process does the reviewing. Two things leave the
laptop: the CLI's own authenticated call to Anthropic (billed to that
developer), and the redacted report to the dashboard.

```
commit  →  .git/logs/HEAD changes
        →  reflog action is "commit"?        no → stop
        →  merge, or no source files?        yes → stop
        →  diff of that commit  →  claude -p  →  findings
        →  squiggles + Findings panel
        →  report  →  redact  →  POST  →  dashboard
                              ↘ on failure, queue on disk and retry
```

| Component | Responsibility |
|---|---|
| CLI locator | PATH → known install dirs → `crTrack.claudePath`; version gate |
| Git locator | `crTrack.gitPath` → VS Code `git.path` → PATH → install dirs |
| Commit watcher | Watch `.git/logs/HEAD`, debounce 1.2s, gate on the reflog action |
| Commit inspector | Parents, author, subject; per-commit diff and stats |
| Review runner | Spawn the CLI, feed the diff on stdin, parse the schema-validated result |
| Diagnostics + tree | Findings → squiggles and a panel grouped by folder and file |
| Report builder + redactor | git metadata, diffstats, commit block; strip secrets |
| Telemetry client | Local JSON + POST with a disk-backed retry queue |
| Process registry | Every spawned child tracked, killed as a tree on teardown |

## Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Local Claude CLI as the engine** | Every developer is already authenticated. No API key to distribute, no backend to host, no per-key rotation problem. Usage bills to each developer's own account. |
| D2 | **Trigger on commit, not on stage** | Reviewing staged changes fired on `git add`, which is not an event developers think about — a developer who stages everything at commit time saw nothing, and the result was stale by the time anyone pressed commit. The commit is also the unit the dashboard measures. Because the commit has already happened, a slow review costs nothing and can never be bypassed with `--no-verify`. |
| D3 | **The reflog decides what is a commit** | `.git/logs/HEAD` gains a line for every HEAD move; only its action word separates a commit from a checkout, reset or rebase. Watching the file alone would review an unrelated branch's entire diff on every switch. |
| D4 | **Skip merges and non-code** | A merge's diff is everything both branches did, and a README change has no logic to be wrong about. Reviewing either teaches the developer that CR-Track fires at random. |
| D5 | **`--json-schema` for output** | Validated findings or a loud failure. Deletes the parse-repair loop entirely. |
| D6 | **`--tools "Read,Grep,Glob"`** | Read-only is enforced by the harness, not requested in a prompt. No Write, no Bash, no network. |
| D7 | **Diff on stdin, prompt via `--append-system-prompt-file`** | Windows caps a command line near 32,000 chars. Both would exceed it as argv. |
| D8 | **Byte-stable prompt prefix** | Ruleset and guides assembled in fixed order with nothing per-run interpolated, so prompt caching works. Interpolating the file count once cost ~40k cache-creation tokens per review. |
| D9 | **Diagnostics, not chat** | Native surface developers already read. |
| D10 | **Every failure means "review skipped"** | The CLI is a dependency we do not control. Nothing it does may break the editor. |
| D11 | **Kill children as a tree** | Windows has no process groups and `SIGTERM` is advisory, so a killed `claude.cmd` leaves node children holding handles inside the extension directory — which is why an uninstall could fail. `taskkill /T /F`, plus a kill-all on deactivate. |
| D12 | **A default dashboard endpoint** | An extension that reports nowhere until each user configures it reports nowhere. |

## Model I/O contract

**In:** unified diff on stdin; ruleset + matched language guides as the system
prompt; read-only repo access for context.

**Out:** one schema-validated object — `findings[]` with `file`, `lineStart`,
`lineEnd`, `severity`, `category`, `title`, `description`, `suggestion`,
`confidence`, plus optional report-only `annotations[]`.

No `id`, no `status`, no envelope. The engine assigns ids deterministically
after filtering (severity → path → line → category) so the same change set
always produces the same numbering.

## Cache key

```
sha256(diff + model + effort + profile + categories + minSeverity + guides)
```

Anything that changes the answer is in it. A timestamp, review id, or branch
name must never be — that would make every key unique and the cache useless.

## Report contract

The dashboard validates `source` against the exact string `claude-code-skill`,
which predates this extension; `client.surface` carries what actually produced
the report. `changes[]` is required even when empty. The commit — sha, message,
author, timestamp — travels inside `review.commit` so a review can be attributed
without inferring it from a branch name.

Redaction runs last, over the whole assembled report including anything the
model wrote.

## What is deliberately absent

Reviewing arbitrary files, reviewing the working tree, a commit gate, applying
fixes, accepting or rejecting findings, and a setup walkthrough all existed and
were removed in 0.4.0. Each was a surface that could be broken on a machine we
could not see, and none of them served the trigger the product is about.

## Risks

| Risk | Mitigation |
|---|---|
| Findings are noisy | `crTrack.profile` and `minSeverity` are the throttle. Ship strict, loosen later. |
| CLI missing or version-skewed | Locator with fallback paths and a pinned minimum version; dormant rather than broken. `~/.local/bin` is a real install location that is often **not** on PATH. |
| Latency on large commits | The review is off the critical path — the commit has already landed. A concurrent review is skipped rather than queued. |
| Finding counts used as a developer metric | Counts are non-deterministic. Report categories and trends, not individual rankings. |
