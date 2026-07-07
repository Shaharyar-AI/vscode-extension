# CR-Track rule set — coderabbit-style@2.0

Tag every finding with one **severity** and one **category**.

## Severity — fixable (flow through approve → apply)
- **blocking** — security vulnerabilities, data loss, crashes, correctness bugs
  that will manifest in production. Must fix before commit. (was `critical`)
- **important** — likely bugs, risky patterns, missing error handling, performance
  hazards. Should fix; may conditionally block. (was `warning`)
- **nit** — style, naming, minor maintainability, documentation nits.
- **suggestion** — optional improvement; safe to skip.

Legacy reports/config may still say `critical`/`warning`/`info` — map them
`critical→blocking`, `warning→important`, `info→nit` wherever you encounter them.

## Annotations — report-only (the approval gate NEVER applies these)
- **learning** — an educational note about the code or a better pattern available.
  No fix is proposed; nothing to approve.
- **praise** — explicit recognition of well-done work.

Annotations are produced during the same review pass as findings, but rendered in
their own checklist section (no checkbox — see checklist-format.md), excluded from
the approve→apply flow (Phase 5/6), and excluded from `min_severity_to_report`
filtering (they're always report-only, still subject to `profile`/`categories_enabled`).

## Automation-awareness
If the loaded config shows a linter/formatter is present (`.eslintrc*`,
`.editorconfig`, prettier/biome config, language-native formatters), do NOT raise
findings a linter or formatter would deterministically catch (pure formatting,
import order, quote style, trailing whitespace). Spend effort on human-judgment
findings — logic, security, design, missing tests. This reduces noise;
`detectedBy` stays `"llm"` either way.

## Tone
Phrase findings and suggestions collaboratively — as observations/questions or
proposals, not commands ("Consider parameterizing this query" over "Parameterize
this query"). Tone must NOT change finding ids, ordering, categories, or the
approval-reply grammar in Phase 5.

## Language/framework depth
Read `references/config.md`'s `guides_enabled` section (Phase 2.5 in SKILL.md
loads the matched guide(s) from `references/lang/` and always-on guides from
`references/cross-cutting/`) before reviewing files in a language that has a
guide. Use the loaded guide's checks IN ADDITION TO, never instead of, the
categories below — map every guide finding into one of these categories and the
severity scale above.

## Categories (and what each looks for)
- **security** — injection (SQL/command/template), secrets in code, weak crypto,
  missing authz/authn checks, unsafe deserialization, SSRF/path traversal.
- **correctness** — null/undefined dereferences, off-by-one, unhandled
  error/rejection paths, race conditions / unsynchronized shared state,
  incorrect conditionals, type mismatches, missing imports.
- **performance** — memory leaks / unclosed resources (streams, handles,
  connections), N+1 queries, unnecessary work in hot paths, unbounded
  loops/allocations.
- **maintainability** — high complexity, duplication, dead code, unclear naming,
  large functions, leaky abstractions, magic numbers.
- **testing** — missing/insufficient tests for changed logic, untested error
  paths, missing edge-case coverage.
- **style** — lint/format violations, project-convention deviations.
- **docs** — missing or stale docstrings/comments for public APIs.

## Profile strictness
- **chill** — report only `blocking` and clear `important`s; suppress most
  `nit`/`suggestion`.
- **balanced** (default) — report all, but only high-confidence `nit`/`suggestion`.
- **assertive** — report everything, including speculative `nit`/`suggestion`.

## Cross-file impact
For each changed file, consider the other files in the change set: a changed
function signature, exported symbol, or shared-state access may create findings
in a sibling file. Note cross-file findings against the file where the fix belongs.

## High-level pass (run first, before line-by-line)
Before reviewing files one by one, take one pass over the WHOLE change set for
architecture, performance strategy, and test strategy: do new code paths have
tests, does the change fit the existing structure, is there a cross-cutting
performance risk spanning multiple files? Emit any issues as normal finding
objects — they join the same filtering/sorting/id-assignment as line-level
findings. Then proceed file-by-file as usual.
