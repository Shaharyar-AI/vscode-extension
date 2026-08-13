/**
 * Reviewing files directly, with no git involved.
 *
 * Git is how CR-Track normally decides *what* to review; it was never required
 * to review at all. A folder that is not a repository — a downloaded project, a
 * scratch directory, something a colleague zipped over — left the extension
 * with nothing to do, which is a limitation of the trigger, not the reviewer.
 *
 * Whole files are presented to the model as a synthetic all-additions diff.
 * That is not a trick to avoid work: it means the prompt, the output schema,
 * the severity filter, the confidence floors and the deterministic id
 * assignment are the exact same code paths as a staged review, so there is one
 * reviewer to reason about rather than two.
 */

import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

export interface FileForReview {
  /** Repo- or folder-relative, forward slashes, as it will appear in findings. */
  path: string;
  content: string;
}

/** Refuse anything that would waste a review or blow up the request. */
export const MAX_FILE_BYTES = 400_000;
export const MAX_TOTAL_BYTES = 1_200_000;
export const MAX_FILES = 40;

export interface CollectResult {
  files: FileForReview[];
  skipped: { path: string; reason: string }[];
}

const BINARY_SNIFF_BYTES = 8_000;

/**
 * A NUL byte within the first few KB is the pragmatic test for "not text".
 * Compared by char code so this source file never has to contain one.
 */
function looksBinary(content: string): boolean {
  const window = Math.min(content.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < window; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * Read the given absolute paths, filtering out anything not worth reviewing.
 * Reasons are returned rather than logged so the caller can tell the user
 * exactly what was left out and why.
 */
export function collectFiles(absPaths: string[], baseDir: string): CollectResult {
  const files: FileForReview[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;

  for (const abs of absPaths) {
    const rel = relative(baseDir, abs).replace(/\\/g, "/") || abs.replace(/\\/g, "/");

    if (files.length >= MAX_FILES) {
      skipped.push({ path: rel, reason: `over the ${MAX_FILES}-file limit` });
      continue;
    }

    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: "not a file" });
        continue;
      }
      size = st.size;
    } catch (err) {
      skipped.push({ path: rel, reason: (err as Error).message });
      continue;
    }

    if (size === 0) {
      skipped.push({ path: rel, reason: "empty" });
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: `${Math.round(size / 1024)} KB — too large` });
      continue;
    }
    if (total + size > MAX_TOTAL_BYTES) {
      skipped.push({ path: rel, reason: "would exceed the total size budget" });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch (err) {
      skipped.push({ path: rel, reason: (err as Error).message });
      continue;
    }

    if (looksBinary(content)) {
      skipped.push({ path: rel, reason: "binary" });
      continue;
    }

    total += size;
    files.push({ path: rel, content });
  }

  return { files, skipped };
}

/**
 * Render files as a unified diff in which every line is an addition.
 *
 * The hunk header `@@ -0,0 +1,N @@` makes the new-file line numbers 1..N, so a
 * finding's `lineStart` lands on the real line in the real file and the
 * existing quick-fix and diagnostic code needs no special case.
 */
export function synthesizeDiff(files: FileForReview[]): string {
  const out: string[] = [];

  for (const file of files) {
    // Trailing newlines would otherwise produce a phantom final line.
    const lines = file.content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    out.push(`diff --git a/${file.path} b/${file.path}`);
    out.push("new file mode 100644");
    out.push("--- /dev/null");
    out.push(`+++ b/${file.path}`);
    out.push(`@@ -0,0 +1,${lines.length} @@`);
    for (const line of lines) out.push(`+${line}`);
  }

  return out.length ? out.join("\n") + "\n" : "";
}
