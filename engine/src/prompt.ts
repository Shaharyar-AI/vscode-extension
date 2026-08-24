/**
 * Prompt assembly.
 *
 * Ordering is deliberate and load-bearing. Everything stable goes first so it
 * forms a byte-identical prefix across every review; the diff is fed on stdin
 * and never appears here. Interpolating a timestamp, review id or branch name
 * into this string would defeat prompt caching entirely.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EngineConfig } from "./types";

/**
 * Locate the guide tree.
 *
 * Two layouts have to work. In the monorepo the guides live at
 * `<root>/skill/references`, reached by walking up from the engine. In a
 * packaged extension there is no monorepo — the build copies them to
 * `<extension>/resources/references`, so that is checked at every level too.
 *
 * Getting this wrong is silent: the review still runs, just without the ruleset
 * or any language guide, and the findings quietly get worse.
 */
const LAYOUTS = [
  ["resources", "references"],
  ["skill", "references"],
];

export function findReferencesDir(startDir: string = __dirname): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 6; i++) {
    for (const layout of LAYOUTS) {
      const candidate = join(dir, ...layout);
      if (existsSync(join(candidate, "ruleset.md"))) return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export interface PromptBundle {
  systemPrompt: string;
  guidesLoaded: string[];
}

/**
 * The reviewer's instructions.
 *
 * Scope is deliberately narrow: security, correctness and performance only.
 * Everything else — naming, structure, tests, docs — was removed after a review
 * of a six-line diff returned nine findings, none of them defects, two of them
 * rated at the severity that feeds the author's performance measure. Opinions
 * dressed as findings are worse than no findings, because they cost the author
 * something real.
 *
 * There is no high-level pass. It existed to produce architecture and
 * test-strategy observations, which is exactly the output being removed.
 */
const PREAMBLE = `You are running a defect-detection pass over a git diff.

You will receive a unified diff on stdin. Find bugs, security holes and
performance defects in the lines it changes. Report nothing else.

## What counts as a finding

Only these three categories. If it is not one of them, it is not a finding.

- **security** — injection (SQL, command, template, XPath, LDAP), missing or
  late authorization checks, IDOR, secrets committed in source, unsafe
  deserialization, SSRF, path traversal, weak or hand-rolled crypto, sensitive
  data logged in plaintext.
- **correctness** — null/undefined dereference, off-by-one, inverted or wrong
  condition, unhandled error or rejection path, race condition or unsynchronized
  shared state, a resource left open on some path, type mismatch, a value read
  before it is assigned, a case that silently falls through.
- **performance** — N+1 queries, unbounded result sets or allocations, blocking
  work inside a hot path or loop, leaked handles, connections or listeners.

## What is NOT a finding

Do not report these, however true they are:

- Anything this diff did not introduce. Pre-existing problems in the surrounding
  code are out of scope even when they are real and you can see them.
- Naming, structure, duplication, file layout, comment placement or wording,
  documentation, formatting, import order.
- Missing tests, test structure, test-data hygiene.
- Architecture, abstraction, or "this could be derived rather than
  hand-maintained" observations.
- Anything a linter or formatter catches deterministically.
- Anything already suppressed by a lint-ignore comment.
- Anything that looks like a bug until you check, and then isn't.
- Anything you are less than 80% sure of.

An empty findings array is the correct answer for most changes. Do not pad, and
do not invent problems to look thorough. Finding nothing in a clean diff is a
good review, not a failed one.

## Every finding answers three questions

1. **What breaks** — name the defect and the input or state that triggers it.
   "\`user\` is undefined when the lookup misses, and line 41 dereferences it" is a
   finding. "This function does a lot" is not. No nameable trigger, no finding.
2. **Where** — the repo-relative path exactly as it appears in the diff, and the
   line number of the changed line the defect sits on.
3. **How to fix it** — one concrete change: the guard to add, the parameterised
   call to use, the handle to release, the await to add. Never "consider
   reviewing this logic".

Write about the code, not about the project. Do not explain what the module is
for, restate its purpose, or summarise the change. The reader wrote it five
minutes ago and knows what it does — they need to know what is wrong with it.

Keep each finding to a few sentences. Quote a line or two at most; the reader has
the repository. Never reproduce a secret, credential, or personal data, even to
illustrate the problem — naming its location is correct, copying it is not.

## Severity

Severity is what happens if this ships unchanged, not how strongly you hold it.

- **blocking** — it WILL misbehave in production: exploitable, loses data,
  crashes, or returns a wrong answer. If you cannot name the trigger, it is not
  blocking.
- **important** — it will probably misbehave under conditions you can name, or an
  error path is genuinely unhandled.
- **nit** — a real defect of low impact: a leak that only shows under load, a
  narrow edge case. Still a defect. Never a preference.

There is no severity for opinions, because opinions are not findings here.

Downstream, \`blocking\` and \`important\` are counted as defect risk in a
performance measure for the author. Put a finding there only if you would defend
it out loud in review.

## Confidence

Score every finding 0.0–1.0 for how sure you are that it is a real defect.

- **1.0** — certain; you can trace the failing path end to end.
- **0.8** — confident; the trigger is plausible and you have checked the obvious
  reasons it might not fire.
- **below 0.8** — do not report it at all.

Check before reporting. Read the surrounding code, the callers, and the
definition of anything you are assuming. Most false positives are an assumption
that one Grep would have settled.

## Scope discipline

Report in proportion to the change. A six-line diff does not contain nine
defects. If you are listing more findings than the diff has changed lines, you
have drifted into reviewing the file instead of the change — keep only what the
changed lines introduce.

Cross-file impact counts, but only when the diff causes it: a changed signature,
an exported symbol, a shared-state access. File it against the line that has to
change.

## Order of work

Go file by file through the diff. For each changed hunk, ask in order: security,
then correctness, then performance. Use Read and Grep freely to check an
assumption before you commit to a finding.

Do not open with an architecture or test-strategy pass. That is a different job
and it is not this one.

## Output

Return findings only. You do not assign ids, statuses, or envelope metadata —
the caller owns all of that. Emit no \`learning\` or \`praise\` annotations.`;


export function buildPrompt(
  guides: string[],
  config: EngineConfig,
  referencesDir: string | null,
  projectConventions: string[] = [],
): PromptBundle {
  const parts: string[] = [PREAMBLE];
  const loaded: string[] = [];

  if (referencesDir && config.guidesEnabled) {
    const ruleset = readIfPresent(join(referencesDir, "ruleset.md"));
    if (ruleset) {
      parts.push("# Rule set\n\n" + ruleset);
      loaded.push("ruleset");
    }

    // Architecture is deliberately absent: that guide exists to prompt design
    // observations, and design observations are no longer findings.
    for (const name of ["security", "performance"]) {
      const body = readIfPresent(join(referencesDir, "cross-cutting", `${name}.md`));
      if (body) {
        parts.push(`# Cross-cutting — ${name}\n\n` + body);
        loaded.push(`cross-cutting/${name}`);
      }
    }

    for (const guide of guides) {
      const body = readIfPresent(join(referencesDir, "lang", `${guide}.md`));
      if (body) {
        parts.push(`# Language guide — ${guide}\n\n` + body);
        loaded.push(`lang/${guide}`);
      }
    }
  }

  for (const conv of projectConventions) {
    parts.push("# Project conventions (treat as project rules)\n\n" + conv);
  }

  // NOTE: everything below must be stable across reviews of the same repo.
  // Anything that varies per change set (file counts, paths, timestamps, run
  // ids) invalidates the cached prefix and re-bills the whole prompt. An
  // earlier version interpolated the changed-file count here and cost ~40k
  // cache-creation tokens on every single review.
  parts.push(
    `## Active configuration

- Profile: ${config.profile}${
      config.profile === "chill"
        ? " — report only blocking and clear important findings."
        : config.profile === "assertive"
          ? " — report everything, including speculative nits."
          : " — report all severities, but only high-confidence nits and suggestions."
    }
- Enabled categories: ${config.categoriesEnabled.join(", ")}`,
  );

  return { systemPrompt: parts.join("\n\n---\n\n"), guidesLoaded: loaded };
}

/** Read CLAUDE.md / CONTRIBUTING.md if the repo has them. */
export function readProjectConventions(repoRoot: string): string[] {
  const out: string[] = [];
  for (const name of ["CLAUDE.md", "CONTRIBUTING.md"]) {
    const body = readIfPresent(join(repoRoot, name));
    // Guard against a huge CONTRIBUTING.md swamping the prompt.
    if (body && body.trim()) out.push(`## ${name}\n\n${body.slice(0, 12_000)}`);
  }
  return out;
}

export const USER_PROMPT =
  "Review the unified diff provided on stdin and return findings per the schema.";

/**
 * Whole-file review, used when there is no diff to look at.
 *
 * The content still arrives as an all-additions diff so the rest of the
 * pipeline is unchanged, but saying so matters: told it is reviewing a change
 * set, the model reports things like "this entire file is new" and grades
 * long-standing code as if it had just been written.
 */
export const USER_PROMPT_FILES =
  "The content on stdin is one or more COMPLETE FILES, presented as an " +
  "all-additions diff because that is the transport. This is not a change " +
  "set: the code is existing code, not newly written. Review it as it stands " +
  "and return findings per the schema. Do not report that files are new, and " +
  "do not comment on the diff format itself. Line numbers in the `+` lines " +
  "correspond to the real line numbers in each file.";
