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

const PREAMBLE = `You are running a senior-reviewer pass over a git diff.

You will receive a unified diff on stdin. Review it and return findings.

## Hard rules

- Return findings ONLY. You do not assign ids, statuses, or any envelope
  metadata; the caller owns all of that.
- An empty findings array is a valid and expected answer. A clean change set
  should produce no findings. Do not invent problems to look thorough.
- Every finding must point at a line that the diff actually touches, using the
  repo-relative path exactly as it appears in the diff.
- You may read files in the repository for surrounding context. You cannot
  write, execute, or fetch anything.
- Never quote a secret value in a title, description or suggestion. Referring to
  the location of a hardcoded secret is correct; reproducing it is not.
- Do not raise anything a linter or formatter would catch deterministically
  (pure formatting, import order, quote style, trailing whitespace). Spend the
  effort on logic, security, design and missing tests.
- Phrase findings collaboratively — observations and proposals, not commands.

## Confidence

Set \`confidence\` honestly. Below 0.5 means you are guessing; the caller filters
on it. A precise low-confidence finding is more useful than a vague certain one.`;

const HIGH_LEVEL_PASS = `## Order of work

Take one pass over the whole change set first — architecture, test strategy,
and any cross-file performance risk — then go file by file. Findings from the
high-level pass are ordinary findings; they use the same schema.

Consider cross-file impact: a changed signature, exported symbol, or shared
state access may create a problem in a sibling file. Record such a finding
against the file where the fix belongs.`;

export function buildPrompt(
  guides: string[],
  config: EngineConfig,
  referencesDir: string | null,
  projectConventions: string[] = [],
): PromptBundle {
  const parts: string[] = [PREAMBLE, HIGH_LEVEL_PASS];
  const loaded: string[] = [];

  if (referencesDir && config.guidesEnabled) {
    const ruleset = readIfPresent(join(referencesDir, "ruleset.md"));
    if (ruleset) {
      parts.push("# Rule set\n\n" + ruleset);
      loaded.push("ruleset");
    }

    for (const name of ["architecture", "security", "performance"]) {
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
