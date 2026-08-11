/** The status bar item — the only always-visible surface. */

import * as vscode from "vscode";
import type { State } from "./orchestrator";
import { summarize } from "@engine/render";

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "CR-Track";
    this.item.command = "crTrack.reviewStaged";
    this.dormant("starting…");
    this.item.show();
  }

  update(state: State): void {
    switch (state.kind) {
      case "idle":
        this.item.text = "$(shield) CR-Track";
        this.item.tooltip = "No staged changes. Click to review now.";
        this.item.backgroundColor = undefined;
        this.item.command = "crTrack.reviewStaged";
        break;

      case "running":
        this.item.text = "$(sync~spin) Reviewing…";
        this.item.tooltip = "CR-Track is reviewing your staged changes. Click to cancel.";
        this.item.backgroundColor = undefined;
        this.item.command = "crTrack.cancelReview";
        break;

      case "done": {
        const { findings } = state.outcome;
        const counts = summarize(findings);
        this.item.command = "workbench.actions.view.problems";
        if (findings.length === 0) {
          this.item.text = "$(pass-filled) CR-Track";
          this.item.tooltip = "No findings on the staged changes.";
          this.item.backgroundColor = undefined;
        } else {
          const parts: string[] = [];
          if (counts.blocking) parts.push(`${counts.blocking} blocking`);
          if (counts.important) parts.push(`${counts.important} important`);
          const rest = counts.nit + counts.suggestion;
          if (rest) parts.push(`${rest} minor`);
          this.item.text = `$(warning) CR-Track ${findings.length}`;
          this.item.tooltip = `${parts.join(", ")}. Click to open the Problems panel.`;
          this.item.backgroundColor = counts.blocking
            ? new vscode.ThemeColor("statusBarItem.errorBackground")
            : undefined;
        }
        break;
      }

      case "failed":
        this.item.text = "$(circle-slash) CR-Track";
        this.item.tooltip = `Review failed: ${state.message}\nClick to open the log.`;
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.item.command = "crTrack.showOutput";
        break;
    }
  }

  /** Extension is installed but not operating — say why on hover, quietly. */
  dormant(reason: string): void {
    this.item.text = "$(shield) CR-Track";
    this.item.tooltip = `CR-Track is inactive — ${reason}`;
    this.item.backgroundColor = undefined;
    this.item.command = "crTrack.showOutput";
  }

  dispose(): void {
    this.item.dispose();
  }
}
