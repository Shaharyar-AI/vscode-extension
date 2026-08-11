/**
 * The commit gate.
 *
 * "Gate" overstates it deliberately: this asks a question when there are
 * blocking findings and always offers a way past. It cannot actually prevent a
 * commit — VS Code has no pre-commit hook for extensions, and `--no-verify`
 * exists regardless. Trying to be a hard gate would only teach people to route
 * around the extension.
 */

import * as vscode from "vscode";
import { summarize } from "@engine/render";
import type { Finding } from "@engine/types";
import { log } from "./log";

export interface GateDecision {
  proceed: boolean;
  /** Set when the developer committed despite blocking findings. */
  overrideReason?: string;
}

/**
 * Ask about outstanding findings. Returns whether to carry on with the commit.
 */
export async function askBeforeCommit(
  findings: Finding[],
  opts: { blockOnBlocking: boolean },
): Promise<GateDecision> {
  const counts = summarize(findings);

  // Nothing serious outstanding — say nothing, get out of the way.
  if (findings.length === 0 || counts.blocking === 0 || !opts.blockOnBlocking) {
    return { proceed: true };
  }

  const list = findings
    .filter((f) => f.severity === "blocking")
    .slice(0, 5)
    .map((f) => `  • ${f.id} ${f.title} — ${f.file}:${f.lineStart}`)
    .join("\n");
  const more = counts.blocking > 5 ? `\n  …and ${counts.blocking - 5} more` : "";

  const choice = await vscode.window.showWarningMessage(
    `CR-Track found ${counts.blocking} blocking issue${counts.blocking === 1 ? "" : "s"} in your staged changes.`,
    { modal: true, detail: `${list}${more}` },
    "Review them",
    "Commit anyway",
  );

  if (choice === "Commit anyway") {
    const reason = await vscode.window.showInputBox({
      title: "Committing with blocking findings",
      prompt: "Why? Recorded in the report.",
      placeHolder: "e.g. hotfix — tracked in JIRA-1234",
    });
    if (reason === undefined) {
      log.info("Override cancelled at the reason prompt");
      return { proceed: false };
    }
    log.info(`Committing over ${counts.blocking} blocking finding(s): ${reason || "(no reason)"}`);
    return { proceed: true, overrideReason: reason.trim() || "no reason given" };
  }

  if (choice === "Review them") {
    const first = findings.find((f) => f.severity === "blocking");
    if (first) await reveal(first);
    else await vscode.commands.executeCommand("workbench.actions.view.problems");
  }

  return { proceed: false };
}

/** Open a finding's location and put the cursor on it. */
export async function reveal(finding: Finding, repoRoot?: string): Promise<void> {
  try {
    const uri = repoRoot
      ? vscode.Uri.joinPath(vscode.Uri.file(repoRoot), finding.file)
      : vscode.Uri.file(finding.file);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const line = Math.max(0, Math.min(document.lineCount - 1, (finding.lineStart || 1) - 1));
    const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.end);
  } catch (err) {
    log.warn(`Could not reveal ${finding.file}:${finding.lineStart}`);
    await vscode.commands.executeCommand("workbench.actions.view.problems");
  }
}

/**
 * Run the repository's commit through the built-in Git extension.
 *
 * Deliberately delegating rather than shelling out to `git commit`: the Git
 * extension owns the commit message box, hooks, signing and the SCM refresh,
 * and reimplementing any of that would drift from what the developer expects.
 */
export async function runGitCommit(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("git.commit");
    return true;
  } catch (err) {
    log.error("git.commit failed", err);
    void vscode.window.showErrorMessage("CR-Track: the commit command failed. See the log.");
    return false;
  }
}
