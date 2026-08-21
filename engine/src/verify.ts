/**
 * Confirming fixes.
 *
 * When a commit lands, the findings from the previous one are still on screen.
 * Some of them are what the developer has just been working on. Rather than
 * guess from the fact that a file changed — a file can be edited anywhere
 * without touching the problem — this asks the reviewer directly: here is the
 * diff, here is what you said last time, which of these does this diff fix?
 *
 * It is a second, small call. That costs a little, and it buys the difference
 * between showing a developer a green tick that means something and one that
 * means a file was saved.
 */

import { run } from "./proc";

export interface PriorFinding {
  id: string;
  file: string;
  lineStart: number;
  title: string;
  description: string;
}

export interface VerifyInput {
  claudePath: string;
  repoRoot: string;
  diff: string;
  prior: PriorFinding[];
  model: string;
  timeoutMs: number;
  onSpawn?: (child: unknown) => void;
}

const SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["fixed"],
  properties: {
    fixed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason"],
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
});

const INSTRUCTION = [
  "You previously reported the problems listed below in this repository.",
  "A new commit has just landed; its diff is on stdin.",
  "",
  "Decide which of those problems this diff actually fixes.",
  "",
  "Include an id only when the diff demonstrably resolves that problem. Read the",
  "file if you need to see the surrounding code. If a problem is untouched, only",
  "partially addressed, moved, or merely reformatted, leave it out. If you are",
  "unsure, leave it out — saying a problem is fixed when it is not is far worse",
  "than leaving it open, because the developer will stop looking at it.",
  "",
  "Return only ids from the list.",
].join("\n");

/** Ids of the prior findings this diff fixes. Empty on any failure. */
export async function verifyFixes(input: VerifyInput): Promise<string[]> {
  if (!input.prior.length) return [];

  const list = input.prior
    .map(
      (f) =>
        `- id: ${f.id}\n  file: ${f.file}:${f.lineStart}\n  problem: ${f.title}\n  detail: ${f.description}`,
    )
    .join("\n");

  const args = [
    "-p",
    `${INSTRUCTION}\n\nPreviously reported:\n${list}`,
    "--model",
    input.model,
    "--tools",
    "Read,Grep,Glob",
    "--permission-mode",
    "dontAsk",
    "--json-schema",
    SCHEMA,
    "--output-format",
    "json",
    "--add-dir",
    input.repoRoot,
    "--no-session-persistence",
  ];

  try {
    const result = await run(input.claudePath, args, {
      cwd: input.repoRoot,
      stdin: input.diff,
      timeoutMs: input.timeoutMs,
      onSpawn: input.onSpawn,
    });
    if (result.timedOut || result.code !== 0) return [];

    const envelope = JSON.parse(result.stdout.trim()) as { result?: unknown };
    const payload =
      typeof envelope.result === "string"
        ? (JSON.parse(envelope.result) as { fixed?: { id?: string }[] })
        : (envelope.result as { fixed?: { id?: string }[] });

    const known = new Set(input.prior.map((f) => f.id));
    return (payload?.fixed ?? [])
      .map((f) => f?.id)
      .filter((id): id is string => typeof id === "string" && known.has(id));
  } catch {
    // Verification is an enhancement. If it fails for any reason the findings
    // simply stay open, which is the safe direction and the old behaviour.
    return [];
  }
}
