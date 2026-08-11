# cr-track-engine

Phase 0 of the CR-Track VS Code extension: the review engine, standalone.

No VS Code, no UI. It takes a git diff, drives the local Claude CLI over it, and
returns filtered, numbered findings. This is the piece the extension will wrap —
and the piece worth proving before anything is wrapped around it.

See [`../docs/cr-track-extension-cli.png`](../docs/cr-track-extension-cli.png)
for where this sits in the whole design. This package is panels ② steps 3–7 and
③ of that diagram.

## Build

```bash
npm install
npm run build
npm test          # 25 logic tests, no CLI required
```

## Use

```bash
node dist/cli.js                            # review staged changes
node dist/cli.js --scope committed          # this branch vs its base
node dist/cli.js --diff-file saved.diff     # replay a saved diff
node dist/cli.js --dry-run                  # print the invocation, call nothing
node dist/cli.js --json out.json -v         # full result to disk
```

Exit codes: `0` clean or advisory only · `1` blocking findings · `2` could not review.

## What it does

| Module | Responsibility |
|---|---|
| `claude-cli.ts` | Find the CLI (PATH → known install dirs → override), check version, report failures as data rather than throwing |
| `git.ts` | Repo context, scoped diff, numstat/name-status → `DiffStats` |
| `languages.ts` | Extension → language → which guides to load |
| `prompt.ts` | Assemble the system prompt from `../skill/references/` |
| `schema.ts` | The output contract handed to `--json-schema` |
| `review.ts` | Build the invocation, spawn, parse, filter, number |
| `render.ts` | Terminal output (the extension renders diagnostics instead) |
| `proc.ts` | Child-process plumbing, including the Windows `.cmd` and argv-length traps |

## Design notes

**The model returns findings and nothing else.** No ids, no status, no envelope,
no upload logic. `--json-schema` enforces it, so there is no parse-repair loop.
Ids are assigned afterwards by sorting on severity → path → line → category, so
the same change set always produces the same numbering.

**The diff goes in on stdin.** Windows caps a command line near 32,000
characters; a moderate diff exceeds that. The system prompt is large too, so it
goes to a temp file via `--append-system-prompt-file`.

**Read-only is enforced, not requested.** `--tools "Read,Grep,Glob"` means the
model physically cannot write files, run commands, or reach the network. No
prompt wording is load-bearing for that.

**The prompt prefix is byte-stable.** Ruleset, guides, and config text are
assembled in a fixed order with nothing per-run interpolated, so prompt caching
actually works. Adding a timestamp or run id to `prompt.ts` would silently
destroy that.

**Cache key** is `sha256(diff + model + effort + profile + categories +
minSeverity + guides)`, truncated to 32 chars. Anything that changes the answer
is in it; anything that varies per run is not.

**No spend cap by default.** Review quality is the objective; a cap only ever
abandons a review partway through and throws the work away. `--budget` exists if
you ever want one, and `0` (the default) means no cap.

**Keep the prompt prefix byte-stable.** An earlier version interpolated the
changed-file count into the system prompt. Because that varies per review it
invalidated the cached prefix every single time, which showed up in an eval run
as ~40k cache-creation tokens per review and a third of the run dying partway
through. Do not add per-run values to `prompt.ts`.

## Not done yet

Verified against a live CLI. `claude` was not installed on the machine this was
written on, so the spawn path and the exact `--output-format json` envelope are
unexercised. `extractResult()` unwraps several plausible envelope shapes and the
self-test covers each, but the first real run may need a tweak there.

Everything else — git handling, language detection, prompt assembly, filtering,
numbering, cache keys — is tested and working.

## Next

1. Run against 30–40 real commits from your repos. Read every finding.
2. Tune `profile`, `minSeverity`, and the confidence floors in `filterFindings`
   against what you see.
3. Only then wrap it in the extension.
