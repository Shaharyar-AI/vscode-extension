import type { Finding } from "@engine/types";

/** What a new review means for the findings already on screen. */
export interface Reconciled {
  /** Everything to show, newest problems first. */
  findings: Finding[];
  /** Ids to mark green — the reviewer read the diff and confirmed the fix. */
  resolvedIds: string[];
}

/** Words too common to identify a finding by. */
const NOISE = new Set([
  "the", "a", "an", "is", "are", "was", "in", "on", "at", "to", "of", "and",
  "or", "but", "not", "no", "it", "its", "this", "that", "for", "with", "as",
  "by", "from", "into", "when", "then", "than", "so", "can", "will", "would",
]);

function signature(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !NOISE.has(w)),
  );
}

/** How much two titles have in common, 0..1 against the smaller of the two. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Two findings describe the same problem if they are in the same file and say
 * substantially the same thing. Line numbers are deliberately ignored: editing
 * a file moves every finding below the edit, so matching on position would
 * report the same problem as both resolved and newly found.
 */
function sameProblem(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  return overlap(signature(a.title), signature(b.title)) >= 0.6;
}

/**
 * Work out what the latest review says about the findings already on screen.
 *
 * A previous finding is only called fixed when the reviewer was shown the diff
 * and said so. Silence is not evidence: a review sees a diff, not a whole file,
 * so a problem can go unmentioned simply because nobody looked at it. Anything
 * unconfirmed carries forward exactly as it was.
 *
 * Where the two directions of error are not equal, this errs towards leaving a
 * finding open. Wrongly showing green tells a developer a problem is dealt with
 * when it is not, which is worse than making them tick a box.
 */
export function reconcile(
  previous: Finding[],
  fresh: Finding[],
  confirmedFixed: string[],
): Reconciled {
  const confirmed = new Set(confirmedFixed);

  const carried: Finding[] = [];
  const resolvedIds: string[] = [];

  for (const old of previous) {
    // Raised again, in its new position — the fresh copy replaces this one.
    if (fresh.some((f) => sameProblem(f, old))) continue;

    carried.push(old);
    // Green only on evidence: the reviewer read the diff and said this one is
    // fixed. Absence from the new review is not evidence — it only reviewed a
    // diff, and most of the file was never in front of it.
    if (confirmed.has(old.id)) resolvedIds.push(old.id);
  }

  return { findings: [...fresh, ...carried], resolvedIds };
}
