/**
 * First-run readiness.
 *
 * The extension has three preconditions — a folder, a usable Claude CLI, and
 * (for staged review) a git repository. Every failure report so far has been
 * one of them unmet, discovered only after someone concluded the extension was
 * broken. The fix is not more resilience in the failure path; it is telling the
 * user at install time, once, exactly what is missing and how to fix it.
 */

import * as vscode from "vscode";
import { checkRepo } from "@engine/git";
import { log } from "./log";
import { checkStartup } from "./startup";
import type { Settings } from "./config";

const GREETED_KEY = "crTrack.greetedVersion";

export interface Readiness {
  folder: boolean;
  cli: boolean;
  cliDetail: string;
  repo: boolean;
  repoDetail: string;
  /** Can review something, somehow. */
  usable: boolean;
}

export async function checkReadiness(
  context: vscode.ExtensionContext,
  settings: Settings,
): Promise<Readiness> {
  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;

  const gate = await checkStartup(context, settings.claudePath);
  const cli = gate.ready;
  const cliDetail = gate.ready
    ? `Claude CLI ${gate.version}`
    : (gate.reason ?? "Claude CLI not found");

  let repo = false;
  let repoDetail = "no folder is open";
  if (folderUri) {
    const check = await checkRepo(folderUri.fsPath);
    repo = check.ok;
    repoDetail = check.ok ? "git repository" : check.detail;
  }

  // Context keys drive the walkthrough's tick marks.
  void vscode.commands.executeCommand("setContext", "crTrack.cliReady", cli);
  void vscode.commands.executeCommand("setContext", "crTrack.repoReady", repo);

  return {
    folder: Boolean(folderUri),
    cli,
    cliDetail,
    repo,
    repoDetail,
    // File review needs a folder and the CLI. Git is a bonus, not a gate.
    usable: Boolean(folderUri) && cli,
  };
}

/**
 * Say hello once per version, and only when there is something to say.
 *
 * A working install should be silent — a notification on every launch is how a
 * useful extension becomes one people disable.
 */
export async function greetIfNeeded(
  context: vscode.ExtensionContext,
  readiness: Readiness,
  version: string,
): Promise<void> {
  if (readiness.usable && readiness.repo) {
    // Fully working: remember it, stay quiet.
    await context.globalState.update(GREETED_KEY, version);
    return;
  }
  if (context.globalState.get<string>(GREETED_KEY) === version) return;
  await context.globalState.update(GREETED_KEY, version);

  if (!readiness.cli) {
    log.warn(`Setup incomplete — ${readiness.cliDetail}`);
    const choice = await vscode.window.showWarningMessage(
      "CR-Track needs the Claude CLI before it can review anything.",
      "Show me how",
      "Copy install command",
    );
    if (choice === "Show me how") await openWalkthrough();
    else if (choice === "Copy install command") {
      await vscode.env.clipboard.writeText("npm i -g @anthropic-ai/claude-code");
      void vscode.window.showInformationMessage(
        "Copied. Run it in a terminal, then `claude` to sign in, then reload the window.",
      );
    }
    return;
  }

  if (!readiness.repo) {
    // Usable, just not fully. Worth one quiet note, not a warning.
    const choice = await vscode.window.showInformationMessage(
      "CR-Track is ready. This folder is not a git repository, so review files directly: right-click one and choose CR-Track: Review This File.",
      "Show me how",
    );
    if (choice === "Show me how") await openWalkthrough();
  }
}

export async function openWalkthrough(): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "ikonic.cr-track#crTrackSetup",
      false,
    );
  } catch (err) {
    log.warn(`Could not open the walkthrough: ${(err as Error).message}`);
    log.show();
  }
}

/** A readable summary for the palette command and the walkthrough button. */
export function describe(readiness: Readiness): string {
  const tick = (b: boolean) => (b ? "yes" : "NO");
  return (
    `folder open: ${tick(readiness.folder)} · ` +
    `Claude CLI: ${tick(readiness.cli)} (${readiness.cliDetail}) · ` +
    `git repository: ${tick(readiness.repo)} (${readiness.repoDetail})`
  );
}
