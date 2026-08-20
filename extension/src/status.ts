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
  dormant(reason: string): void {
    this.item.text = "$(shield) CR-Track · inactive";
    this.item.tooltip = `CR-Track is inactive — ${reason}.\nClick to run Diagnose.`;
    this.item.backgroundColor = undefined;
    this.item.command = "crTrack.diagnose";
  }

  dispose(): void {
    this.item.dispose();
  }
}
