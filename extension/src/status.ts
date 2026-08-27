/**
 * The status bar item — the only always-visible surface.
 *
 * Four states, and each one says in its *text* what is going on. A tooltip only
 * helps someone who already suspects the extension is working; the people who
 * report it as broken never hover.
 */

import * as vscode from "vscode";

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "CR-Track";
    this.dormant("starting");
    this.item.show();
  }

  /** Armed and waiting for a commit. */
  idle(what: string): void {
    this.item.text = "$(shield) CR-Track";
    this.item.tooltip = `CR-Track is ${what}.\nEvery new commit is reviewed automatically.`;
    this.item.backgroundColor = undefined;
    this.item.command = "crTrack.showOutput";
  }

  busy(what: string): void {
    this.item.text = "$(sync~spin) CR-Track reviewing…";
    this.item.tooltip = `${what}.\nClick to watch the log.`;
    this.item.backgroundColor = undefined;
    this.item.command = "crTrack.showOutput";
  }

  reviewed(count: number, shortSha: string): void {
    if (count === 0) {
      this.item.text = "$(pass-filled) CR-Track";
      this.item.tooltip = `No findings on ${shortSha}. Nice commit.`;
      this.item.backgroundColor = undefined;
      this.item.command = "crTrack.showOutput";
      return;
    }
    this.item.text = `$(warning) CR-Track ${count}`;
    this.item.tooltip = `${count} recommendation(s) on ${shortSha}.\nClick to open the panel.`;
    this.item.backgroundColor = undefined;
    this.item.command = "crTrack.findings.focus";
  }

  failed(message: string): void {
    this.item.text = "$(circle-slash) CR-Track";
    this.item.tooltip = `Review failed: ${message}\nClick to open the log.`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.command = "crTrack.showOutput";
  }

  /**
   * Installed but not operating. Says so in the text, and offers the one
   * command that explains why — an inactive extension the user cannot act on is
   * the worst of both worlds.
   */
  /**
   * A report the developer chose not to send yet.
   *
   * Distinct from every other state: nothing is wrong, nothing is running, and
   * the dashboard is missing this review only because they said so. Showing it
   * as idle would make a deliberate hold indistinguishable from a sent report.
   */
  held(shortSha: string, findings: number): void {
    this.item.text = `$(circle-outline) CR-Track ${findings} held`;
    this.item.tooltip =
      `${findings} finding(s) in ${shortSha} are not on the dashboard yet.
` +
      "Fix and commit again, or send it from the Findings panel.";
    this.item.backgroundColor = undefined;
    this.item.command = "crTrack.findings.focus";
  }

  dormant(reason: string): void {
    // The reason goes in the *text*, not just the tooltip. "inactive" on its own
    // sends people round a disable/reload/enable loop that cannot possibly help,
    // because none of it addresses a missing CLI or a missing repository.
    this.item.text = "$(shield) CR-Track · " + shortReason(reason);
    this.item.tooltip = "CR-Track is inactive — " + reason + ".\nClick to run Diagnose.";
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.command = "crTrack.diagnose";
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * Compress a reason into something that fits a status bar without lying.
 * Anything unrecognised falls back to "inactive" rather than being cut off
 * mid-sentence.
 */
function shortReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("claude")) return "no Claude CLI";
  if (r.includes("no git repository")) return "not a git repo";
  if (r.includes("git")) return "git unavailable";
  if (r.includes("no folder")) return "no folder open";
  // Distinct from "disabled": the developer chose this repository, and telling
  // them it is "inactive" sends them to Diagnose, which will find nothing wrong.
  if (r.startsWith("off in")) return "off here";
  if (r.includes("disabled")) return "disabled";
  if (r.includes("starting")) return "starting";
  return "inactive";
}
