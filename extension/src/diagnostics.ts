/**
 * Findings rendered as native diagnostics.
 *
 * This is the whole approval surface. Squiggles in the editor and rows in the
 * Problems panel are where developers already look; a bespoke checklist would
 * be one more thing to learn and one more place to ignore.
 */

import * as vscode from "vscode";
import type { Finding, Severity } from "@engine/types";

const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  blocking: vscode.DiagnosticSeverity.Error,
  important: vscode.DiagnosticSeverity.Warning,
  nit: vscode.DiagnosticSeverity.Information,
  suggestion: vscode.DiagnosticSeverity.Hint,
};

/** A diagnostic that remembers which finding produced it. */
export interface FindingDiagnostic extends vscode.Diagnostic {
  finding: Finding;
}

export class DiagnosticsView implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("cr-track");
  /** Findings by document URI, so the quick-fix provider can look them up. */
  private readonly byUri = new Map<string, Finding[]>();

  constructor(private readonly repoRoot: string) {}

  show(findings: Finding[]): void {
    this.collection.clear();
    this.byUri.clear();

    const grouped = new Map<string, Finding[]>();
    for (const f of findings) {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(this.repoRoot), f.file);
      const key = uri.toString();
      const list = grouped.get(key) ?? [];
      list.push(f);
      grouped.set(key, list);
    }

    for (const [key, group] of grouped) {
      const uri = vscode.Uri.parse(key);
      this.byUri.set(key, group);
      this.collection.set(uri, group.map((f) => this.toDiagnostic(f)));
    }
  }

  findingsFor(uri: vscode.Uri): Finding[] {
    return this.byUri.get(uri.toString()) ?? [];
  }

  /** Drop one finding — it was applied or dismissed, so the squiggle goes. */
  remove(id: string): void {
    for (const [key, group] of this.byUri) {
      const kept = group.filter((f) => f.id !== id);
      if (kept.length === group.length) continue;

      const uri = vscode.Uri.parse(key);
      if (kept.length === 0) {
        this.byUri.delete(key);
        this.collection.delete(uri);
      } else {
        this.byUri.set(key, kept);
        this.collection.set(uri, kept.map((f) => this.toDiagnostic(f)));
      }
      return;
    }
  }

  /** Findings still on screen, in id order. */
  remaining(): Finding[] {
    return [...this.byUri.values()]
      .flat()
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  clear(): void {
    this.collection.clear();
    this.byUri.clear();
  }

  private toDiagnostic(f: Finding): FindingDiagnostic {
    // The model reports 1-based inclusive lines; VS Code ranges are 0-based.
    // Clamp defensively — a bad line number should not throw.
    const start = Math.max(0, (f.lineStart || 1) - 1);
    const end = Math.max(start, (f.lineEnd || f.lineStart || 1) - 1);
    const range = new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);

    const d = new vscode.Diagnostic(
      range,
      `${f.title}\n\n${f.description}\n\nSuggested: ${f.suggestion}`,
      SEVERITY_MAP[f.severity] ?? vscode.DiagnosticSeverity.Information,
    ) as FindingDiagnostic;

    d.source = "CR-Track";
    // Shown in the Problems panel as the rule id — makes findings referenceable.
    d.code = `${f.id} · ${f.category} · ${Math.round((f.confidence ?? 0) * 100)}%`;
    d.finding = f;
    return d;
  }

  dispose(): void {
    this.collection.dispose();
  }
}
