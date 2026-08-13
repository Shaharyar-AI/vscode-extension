/**
 * The startup gate.
 *
 * The Claude CLI is a dependency we do not control. If it is missing, stale, or
 * unauthenticated, the extension goes dormant and says so exactly once. It never
 * nags per commit, and it never blocks anything.
 */

import * as vscode from "vscode";
import { installHint, locateClaude, MIN_CLI_VERSION, type CliStatus } from "@engine/claude-cli";
import { log } from "./log";

const NOTIFIED_KEY = "crTrack.cliWarningShownFor";

export interface Gate {
  ready: boolean;
  claudePath?: string;
  version?: string;
  reason?: string;
}

/**
 * Discovery is expensive — `where claude` plus `claude --version`, which spawns
 * Node and has been measured at 20+ seconds on a cold Windows machine. That is
 * tolerable once at startup and not tolerable on every recovery recheck, so the
 * result is cached.
 *
 * A success is cached for the session. A failure is cached only briefly, so
 * installing the CLI is picked up quickly rather than being remembered as
 * missing for the rest of the window's life.
 */
let cached: { key: string; status: CliStatus; at: number } | undefined;
const FAILURE_TTL_MS = 10_000;

export function clearStartupCache(): void {
  cached = undefined;
}

async function locateCached(override: string | undefined): Promise<CliStatus> {
  const key = override ?? "";
  if (cached && cached.key === key) {
    const fresh = cached.status.ok || Date.now() - cached.at < FAILURE_TTL_MS;
    if (fresh) return cached.status;
  }
  const started = Date.now();
  const status = await locateClaude(override, {
    onOverrideRejected: (path, reason) =>
      log.warn(
        `crTrack.claudePath points at "${path}" but it could not be used (${reason}). ` +
          `Looking elsewhere — clear or correct the setting to silence this.`,
      ),
  });
  const took = Date.now() - started;
  if (took > 3_000) {
    log.info(`CLI discovery took ${(took / 1000).toFixed(1)}s — caching the result`);
  }
  cached = { key, status, at: Date.now() };
  return status;
}

export async function checkStartup(
  context: vscode.ExtensionContext,
  claudePathOverride: string | undefined,
): Promise<Gate> {
  let status: CliStatus;
  try {
    status = await locateCached(claudePathOverride);
  } catch (err) {
    log.error("CLI discovery threw", err);
    return { ready: false, reason: "CLI discovery failed" };
  }

  if (status.ok) {
    log.info(`Claude CLI ${status.version} at ${status.path}`);
    // A later successful check clears the warning, so an upgrade re-arms it.
    void context.globalState.update(NOTIFIED_KEY, undefined);
    return { ready: true, claudePath: status.path, version: status.version };
  }

  log.warn(`Claude CLI unavailable (${status.reason}): ${status.detail}`);
  await notifyOnce(context, status);
  return { ready: false, reason: installHint(status) };
}

/**
 * Show the CLI warning once per distinct problem. Seeing the same modal after
 * every commit is how an extension gets uninstalled.
 */
async function notifyOnce(
  context: vscode.ExtensionContext,
  status: Extract<CliStatus, { ok: false }>,
): Promise<void> {
  const fingerprint = `${status.reason}:${status.path ?? ""}`;
  if (context.globalState.get<string>(NOTIFIED_KEY) === fingerprint) return;
  await context.globalState.update(NOTIFIED_KEY, fingerprint);

  const actions =
    status.reason === "not-found"
      ? ["Copy install command", "Set path…", "Show log"]
      : ["Show log"];

  const choice = await vscode.window.showWarningMessage(
    `CR-Track is inactive — ${installHint(status)}`,
    ...actions,
  );

  if (choice === "Copy install command") {
    await vscode.env.clipboard.writeText("npm i -g @anthropic-ai/claude-code");
    void vscode.window.showInformationMessage(
      "Install command copied. Run it, then reload the window.",
    );
  } else if (choice === "Set path…") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "crTrack.claudePath");
  } else if (choice === "Show log") {
    log.show();
  }
}

export { MIN_CLI_VERSION };
