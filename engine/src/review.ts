/**
 * The review runner: build the invocation, spawn `claude -p`, feed the diff on
 * stdin, and turn stdout into filtered, numbered findings.
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./proc";
import { FINDINGS_SCHEMA_JSON } from "./schema";
import { buildPrompt, readProjectConventions, USER_PROMPT, USER_PROMPT_FILES } from "./prompt";
import { guidesFor } from "./languages";
import {
  DEFAULT_CONFIG,
  SEVERITY_ORDER,
  type Annotation,
  type EngineConfig,
  type Finding,
  type ModelResult,
  type RawAnnotation,
  type RawFinding,
} from "./types";

export interface RunReviewInput {
  claudePath: string;
  repoRoot: string;
  diff: string;
  changedPaths: string[];
  config?: Partial<EngineConfig>;
  referencesDir: string | null;
  /** "files" reviews complete files; "diff" (default) reviews a change set. */
  mode?: "diff" | "files";
  /** Print the invocation and exit without calling the model. */
  dryRun?: boolean;
  onSpawn?: (kill: () => void) => void;
}

/** Usage the CLI reports back. Measured, not estimated. */
export interface UsageReport {
  costUsd: number | null;
  turns: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  /** Fraction of prompt tokens served from cache. Low means a cache miss. */
  cacheHitRatio: number | null;
}

export interface RunReviewOutput {
  findings: Finding[];
  annotations: Annotation[];
  guidesLoaded: string[];
  cacheKey: string;
  durationMs: number;
  command: string[];
  usage?: UsageReport;
  /** True when the run stopped because --max-budget-usd was reached. */
  budgetExhausted?: boolean;
  error?: string;
  rawStdout?: string;
}

/** Pull usage out of the CLI's result envelope. Absent fields become null. */
export function readUsage(envelope: unknown): UsageReport | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const e = envelope as Record<string, any>;
  const u = (e.usage ?? {}) as Record<string, any>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

  const created = num(u.cache_creation_input_tokens);
  const read = num(u.cache_read_input_tokens);
  const total = (created ?? 0) + (read ?? 0);

  return {
    costUsd: num(e.total_cost_usd),
    turns: num(e.num_turns),
    cacheCreationTokens: created,
    cacheReadTokens: read,
    outputTokens: num(u.output_tokens),
    cacheHitRatio: total > 0 ? (read ?? 0) / total : null,
  };
}

/**
 * The cache key. Anything that would change the answer belongs in here;
 * anything that varies per invocation (timestamps, run ids) must not.
 */
export function cacheKeyFor(diff: string, config: EngineConfig, guides: string[]): string {
  return createHash("sha256")
    .update(diff)
    .update("\0")
    .update(config.model)
    .update("\0")
    .update(config.effort)
    .update("\0")
    .update(config.profile)
    .update("\0")
    .update([...config.categoriesEnabled].sort().join(","))
    .update("\0")
    .update(config.minSeverity)
    .update("\0")
    .update(guides.join(","))
    .digest("hex")
    .slice(0, 32);
}

export async function runReview(input: RunReviewInput): Promise<RunReviewOutput> {
  const config: EngineConfig = { ...DEFAULT_CONFIG, ...input.config };
  const guides = guidesFor(input.changedPaths);
  const cacheKey = cacheKeyFor(input.diff, config, guides);

  const { systemPrompt, guidesLoaded } = buildPrompt(
    guides,
    config,
    input.referencesDir,
    readProjectConventions(input.repoRoot),
  );

  // The system prompt is far too large for argv on Windows, so it goes to a
  // temp file. stdin is already taken by the diff.
  const scratch = mkdtempSync(join(tmpdir(), "cr-track-"));
  const promptFile = join(scratch, "system-prompt.md");
  writeFileSync(promptFile, systemPrompt, "utf8");

  const args = [
    "-p",
    input.mode === "files" ? USER_PROMPT_FILES : USER_PROMPT,
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--tools",
    "Read,Grep,Glob",
    "--permission-mode",
    "dontAsk",
    "--append-system-prompt-file",
    promptFile,
    "--json-schema",
    FINDINGS_SCHEMA_JSON,
    "--output-format",
    "json",
    "--add-dir",
    input.repoRoot,
    "--no-session-persistence",
  ];

  // Only cap spend if someone explicitly asks for it. A cap does not make a
  // review cheaper — it abandons one partway through and wastes it entirely.
  if (config.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd));
  }

  const command = [input.claudePath, ...args];

  if (input.dryRun) {
    return {
      findings: [],
      annotations: [],
      guidesLoaded,
      cacheKey,
      durationMs: 0,
      command,
    };
  }

  const started = Date.now();
  const result = await run(input.claudePath, args, {
    cwd: input.repoRoot,
    stdin: input.diff,
    timeoutMs: config.timeoutMs,
    onSpawn: input.onSpawn,
  });
  const durationMs = Date.now() - started;

  if (result.timedOut) {
    return {
      findings: [],
      annotations: [],
      guidesLoaded,
      cacheKey,
      durationMs,
      command,
      error: `review timed out after ${Math.round(config.timeoutMs / 1000)}s`,
    };
  }

  if (result.code !== 0) {
    // A non-zero exit still carries a JSON envelope with usage in it, so read
    // what we can before reporting. Budget exhaustion is a distinct outcome:
    // the config is wrong, not the code.
    let envelope: Record<string, any> | undefined;
    try {
      envelope = JSON.parse(result.stdout.trim());
    } catch {
      /* not JSON — fall through to the raw message */
    }
    const budgetExhausted = envelope?.subtype === "error_max_budget_usd";
    const usage = readUsage(envelope);
    const detail = budgetExhausted
      ? `hit the $${config.maxBudgetUsd} budget after ${envelope?.num_turns ?? "?"} turns` +
        ` (spent $${(usage?.costUsd ?? 0).toFixed(2)}) — raise --budget or lower --effort`
      : (envelope?.errors?.join("; ") as string | undefined) ??
        (result.stderr || result.stdout).trim().split("\n").slice(0, 2).join(" | ") ??
        "(no output)";

    return {
      findings: [],
      annotations: [],
      guidesLoaded,
      cacheKey,
      durationMs,
      command,
      ...(usage ? { usage } : {}),
      ...(budgetExhausted ? { budgetExhausted: true } : {}),
      error: budgetExhausted ? detail : `claude exited ${result.code}: ${detail}`,
      rawStdout: result.stdout,
    };
  }

  let envelope: Record<string, any> | undefined;
  try {
    envelope = JSON.parse(result.stdout.trim());
  } catch {
    /* handled by extractResult below */
  }
  const usage = readUsage(envelope);

  let parsed: ModelResult;
  try {
    parsed = extractResult(result.stdout);
  } catch (err) {
    return {
      findings: [],
      annotations: [],
      guidesLoaded,
      cacheKey,
      durationMs,
      command,
      ...(usage ? { usage } : {}),
      error: `could not read the model's output: ${(err as Error).message}`,
      rawStdout: result.stdout,
    };
  }

  return {
    findings: numberFindings(filterFindings(parsed.findings ?? [], config)),
    annotations: numberAnnotations(filterAnnotations(parsed.annotations ?? [], config)),
    guidesLoaded,
    cacheKey,
    durationMs,
    command,
    ...(usage ? { usage } : {}),
    rawStdout: result.stdout,
  };
}

/**
 * `--output-format json` wraps the answer in a transport envelope. The exact
 * shape has moved between CLI versions, so unwrap defensively rather than
 * assuming one layout: take the payload wherever it turns up.
 */
export function extractResult(stdout: string): ModelResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("empty stdout");

  let top: unknown;
  try {
    top = JSON.parse(trimmed);
  } catch {
    // Some versions emit log lines before the JSON body; take the last object.
    const start = trimmed.lastIndexOf("\n{");
    if (start === -1) throw new Error("stdout was not JSON");
    top = JSON.parse(trimmed.slice(start + 1));
  }

  for (const candidate of unwrap(top)) {
    if (candidate && typeof candidate === "object" && Array.isArray((candidate as ModelResult).findings)) {
      return candidate as ModelResult;
    }
  }
  throw new Error("no `findings` array found in the response");
}

/** Yield the payload itself plus the usual envelope fields it hides behind. */
function* unwrap(top: unknown): Generator<unknown> {
  yield top;
  if (!top || typeof top !== "object") return;
  const obj = top as Record<string, unknown>;
  for (const key of ["result", "output", "structured_output", "structuredOutput", "content", "data"]) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v === "string") {
      try {
        yield JSON.parse(v);
      } catch {
        /* not JSON — ignore */
      }
    } else {
      yield v;
      if (v && typeof v === "object") {
        for (const inner of Object.values(v as Record<string, unknown>)) yield inner;
      }
    }
  }
}

function severityRank(s: string): number {
  const i = SEVERITY_ORDER.indexOf(s as (typeof SEVERITY_ORDER)[number]);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

export function filterFindings(findings: RawFinding[], config: EngineConfig): RawFinding[] {
  const threshold = severityRank(config.minSeverity);
  const enabled = new Set<string>(config.categoriesEnabled);
  const floor = config.minConfidence ?? DEFAULT_CONFIG.minConfidence;

  return findings.filter((f) => {
    if (!f || typeof f.file !== "string") return false;
    if (!enabled.has(f.category)) return false;
    const rank = severityRank(f.severity);
    if (rank > threshold) return false;
    // The floor applies at every severity, not just the low ones. A blocking
    // finding the reviewer is only half sure of is the expensive kind of wrong:
    // it is the severity that counts against the author.
    if (typeof f.confidence === "number" && f.confidence < floor) return false;
    if (config.profile === "chill" && rank > severityRank("important")) return false;
    return true;
  });
}

export function filterAnnotations(
  annotations: RawAnnotation[],
  config: EngineConfig,
): RawAnnotation[] {
  // Annotations skip the severity threshold by design — they are report-only.
  const enabled = new Set<string>(config.categoriesEnabled);
  return annotations.filter((a) => a && typeof a.file === "string" && enabled.has(a.category));
}

/**
 * Deterministic ids: sort by severity, then path, then line, then category, and
 * number in that order. The same change set always yields the same numbering,
 * which is what makes "apply f1 and f3" reproducible.
 */
export function numberFindings(findings: RawFinding[]): Finding[] {
  return [...findings]
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        a.file.localeCompare(b.file) ||
        (a.lineStart ?? 0) - (b.lineStart ?? 0) ||
        a.category.localeCompare(b.category),
    )
    .map((f, i) => ({ ...f, id: `f${i + 1}` }));
}

export function numberAnnotations(annotations: RawAnnotation[]): Annotation[] {
  return [...annotations]
    .sort((a, b) => a.file.localeCompare(b.file) || (a.lineStart ?? 0) - (b.lineStart ?? 0))
    .map((a, i) => ({ ...a, id: `a${i + 1}` }));
}
