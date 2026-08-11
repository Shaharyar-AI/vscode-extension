/** Terminal rendering. Phase 0 only — the extension renders diagnostics instead. */

import type { Annotation, DiffStats, Finding, Severity } from "./types";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const bold = c("1");
const dim = c("2");
const red = c("31;1");
const yellow = c("33;1");
const blue = c("34;1");
const grey = c("90");
const green = c("32;1");
const magenta = c("35;1");

const SEVERITY_STYLE: Record<Severity, { label: string; paint: (s: string) => string }> = {
  blocking: { label: "BLOCKING", paint: red },
  important: { label: "IMPORTANT", paint: yellow },
  nit: { label: "NIT", paint: blue },
  suggestion: { label: "SUGGESTION", paint: grey },
};

export function renderReview(
  findings: Finding[],
  annotations: Annotation[],
  stats: DiffStats,
  meta: { durationMs: number; model: string; effort: string; guidesLoaded: string[]; cached: boolean },
): string {
  const out: string[] = [];
  const filesLabel = `${stats.filesChanged} file${stats.filesChanged === 1 ? "" : "s"}`;

  out.push("");
  out.push(
    bold("CR-Track review") +
      dim(`  ${filesLabel}, +${stats.linesAdded}/-${stats.linesRemoved}`),
  );
  out.push(
    dim(
      `${meta.model} · effort ${meta.effort} · ${(meta.durationMs / 1000).toFixed(1)}s${
        meta.cached ? " · from cache" : ""
      }`,
    ),
  );
  if (meta.guidesLoaded.length) out.push(dim(`guides: ${meta.guidesLoaded.join(", ")}`));
  out.push("");

  if (findings.length === 0 && annotations.length === 0) {
    out.push(green("  No findings. Nice."));
    out.push("");
    return out.join("\n");
  }

  for (const sev of ["blocking", "important", "nit", "suggestion"] as Severity[]) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    const style = SEVERITY_STYLE[sev];
    out.push(style.paint(`  ${style.label} (${group.length})`));
    for (const f of group) {
      const loc = f.lineStart === f.lineEnd ? `${f.lineStart}` : `${f.lineStart}-${f.lineEnd}`;
      out.push(
        `    ${bold(f.id)} ${dim(`[${f.category}]`)} ${f.title}` +
          dim(`  ${f.file}:${loc}  ${Math.round((f.confidence ?? 0) * 100)}%`),
      );
      out.push(`        ${f.description}`);
      if (f.suggestion) out.push(`        ${dim("→")} ${f.suggestion}`);
    }
    out.push("");
  }

  if (annotations.length) {
    out.push(magenta(`  NOTES (${annotations.length})`));
    for (const a of annotations) {
      out.push(
        `    ${bold(a.id)} ${dim(`[${a.severity}]`)} ${a.title}` +
          dim(`  ${a.file}:${a.lineStart}`),
      );
      if (a.description) out.push(`        ${a.description}`);
    }
    out.push("");
  }

  const counts = summarize(findings);
  out.push(
    dim(
      `  ${findings.length} finding${findings.length === 1 ? "" : "s"} — ` +
        (["blocking", "important", "nit", "suggestion"] as Severity[])
          .map((s) => `${counts[s]} ${s}`)
          .join(", "),
    ),
  );
  out.push("");
  return out.join("\n");
}

export function summarize(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocking: 0, important: 0, nit: 0, suggestion: 0 };
  for (const f of findings) if (f.severity in counts) counts[f.severity]++;
  return counts;
}
