/**
 * Quick fixes.
 *
 * Three actions hang off each finding: apply the patch (when the model supplied
 * one), dismiss it, or copy the suggestion. Only the developer's explicit
 * choice edits a file — nothing here runs on its own.
 */

import * as vscode from "vscode";
import type { Finding } from "@engine/types";
import type { DiagnosticsView, FindingDiagnostic } from "./diagnostics";
import { log } from "./log";

export type Outcome = "applied" | "dismissed";

export class FixProvider implements vscode.CodeActionProvider, vscode.Disposable {
  /** Finding id → what the developer did with it, for the report. */
  private readonly outcomes = new Map<string, { outcome: Outcome; reason?: string }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly view: DiagnosticsView) {
    // Resolved here rather than in a static field: a static initializer runs at
    // module load, before the host has necessarily finished setting up the API.
    this.disposables.push(
      vscode.languages.registerCodeActionsProvider({ scheme: "file" }, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.commands.registerCommand("crTrack.applyFix", (f: Finding, uri: vscode.Uri) =>
        this.apply(f, uri),
      ),
      vscode.commands.registerCommand("crTrack.dismissFinding", (f: Finding) => this.dismiss(f)),
      vscode.commands.registerCommand("crTrack.copySuggestion", async (f: Finding) => {
        await vscode.env.clipboard.writeText(f.suggestion);
        void vscode.window.showInformationMessage(`Copied the suggestion for ${f.id}.`);
      }),
    );
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      const finding = (diagnostic as FindingDiagnostic).finding;
      if (!finding || diagnostic.source !== "CR-Track") continue;
      if (this.outcomes.has(finding.id)) continue;

      if (finding.fix) {
        const fix = new vscode.CodeAction(
          `CR-Track: fix — ${finding.title}`,
          vscode.CodeActionKind.QuickFix,
        );
        fix.diagnostics = [diagnostic];
        fix.isPreferred = finding.severity === "blocking" || finding.severity === "important";
        fix.command = {
          command: "crTrack.applyFix",
          title: "Apply",
          arguments: [finding, document.uri],
        };
        actions.push(fix);
      }

      const dismiss = new vscode.CodeAction(
        `CR-Track: dismiss ${finding.id}`,
        vscode.CodeActionKind.QuickFix,
      );
      dismiss.diagnostics = [diagnostic];
      dismiss.command = {
        command: "crTrack.dismissFinding",
        title: "Dismiss",
        arguments: [finding],
      };
      actions.push(dismiss);

      const copy = new vscode.CodeAction(
        `CR-Track: copy suggestion for ${finding.id}`,
        vscode.CodeActionKind.QuickFix,
      );
      copy.command = {
        command: "crTrack.copySuggestion",
        title: "Copy",
        arguments: [finding],
      };
      actions.push(copy);
    }

    return actions;
  }

  /**
   * Apply a patch, but only if the file still looks like what was reviewed.
   * Line numbers shift the moment anything above them is edited, so a blind
   * range replacement is a corruption waiting to happen.
   */
  private async apply(finding: Finding, uri: vscode.Uri): Promise<void> {
    if (!finding.fix) return;

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      void vscode.window.showErrorMessage(`CR-Track: could not open ${uri.fsPath}`);
      log.error("openTextDocument failed", err);
      return;
    }

    const range = this.rangeFor(document, finding);
    const current = document.getText(range);

    if (normalise(current) !== normalise(finding.fix.oldText)) {
      const choice = await vscode.window.showWarningMessage(
        `CR-Track: ${uri.fsPath.split(/[\\/]/).pop()} has changed since the review, so this fix may no longer be correct.`,
        "Show me the finding",
        "Cancel",
      );
      if (choice === "Show me the finding") {
        const editor = await vscode.window.showTextDocument(document);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.end);
      }
      log.warn(`Refused stale fix for ${finding.id} in ${finding.file}`);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, finding.fix.newText);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      void vscode.window.showErrorMessage(`CR-Track: could not apply the fix for ${finding.id}.`);
      return;
    }

    this.outcomes.set(finding.id, { outcome: "applied" });
    this.view.remove(finding.id);
    log.info(`Applied ${finding.id} — ${finding.title}`);
  }

  private async dismiss(finding: Finding): Promise<void> {
    const reason = await vscode.window.showInputBox({
      title: `Dismiss ${finding.id}`,
      prompt: "Why? Recorded in the report, and used to suppress this in future reviews.",
      placeHolder: "e.g. intentional — validated upstream",
    });
    // Escape cancels the dismissal entirely rather than dismissing blankly.
    if (reason === undefined) return;

    this.outcomes.set(finding.id, { outcome: "dismissed", reason: reason.trim() || "not selected" });
    this.view.remove(finding.id);
    log.info(`Dismissed ${finding.id} — ${reason || "(no reason given)"}`);
  }

  /** The reviewed range, clamped to the document as it exists now. */
  private rangeFor(document: vscode.TextDocument, finding: Finding): vscode.Range {
    const last = Math.max(0, document.lineCount - 1);
    const start = Math.min(last, Math.max(0, (finding.lineStart || 1) - 1));
    const end = Math.min(last, Math.max(start, (finding.lineEnd || finding.lineStart || 1) - 1));
    return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
  }

  outcomeFor(id: string): { outcome: Outcome; reason?: string } | undefined {
    return this.outcomes.get(id);
  }

  allOutcomes(): ReadonlyMap<string, { outcome: Outcome; reason?: string }> {
    return this.outcomes;
  }

  reset(): void {
    this.outcomes.clear();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Compare ignoring line endings and trailing whitespace only. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}
