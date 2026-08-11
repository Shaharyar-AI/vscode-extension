/**
 * CR-Track — entry point.
 *
 * Wiring only: discover the repo, gate on the CLI, watch the index, and hand
 * results to the diagnostics view. Everything substantive lives in the engine
 * or in the modules beside this one.
 */

import * as vscode from "vscode";
import { readSettings, type Settings } from "./config";
import { DiagnosticsView } from "./diagnostics";
import { initLog, log } from "./log";
import { Orchestrator, type State } from "./orchestrator";
import { checkStartup } from "./startup";
import { StatusBar } from "./status";
import { IndexWatcher } from "./watcher";
import { isRepo, readRepoContext } from "@engine/git";

let session: Session | undefined;

/** Everything that exists only while a usable repo + CLI are present. */
class Session implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly repoRoot: string,
    readonly orchestrator: Orchestrator,
    readonly diagnostics: DiagnosticsView,
    readonly status: StatusBar,
    watcher: IndexWatcher,
  ) {
    this.disposables.push(orchestrator, diagnostics, watcher);

    this.disposables.push(
      orchestrator.onDidChangeState((state) => {
        status.update(state);
        this.render(state);
      }),
    );
  }

  private render(state: State): void {
    if (state.kind === "done") {
      this.diagnostics.show(state.outcome.findings);
    } else if (state.kind === "idle") {
      this.diagnostics.clear();
    }
    // "running" and "failed" deliberately leave the previous findings on
    // screen — stale results beat a blank Problems panel mid-review.
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());
  log.info("CR-Track activating");

  const status = new StatusBar();
  context.subscriptions.push(status);

  registerCommands(context, status);

  await start(context, status);

  // Re-evaluate when the settings that decide whether we can run at all change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (
        e.affectsConfiguration("crTrack.enabled") ||
        e.affectsConfiguration("crTrack.claudePath")
      ) {
        log.info("Configuration changed — restarting");
        await start(context, status);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      log.info("Workspace folders changed — restarting");
      await start(context, status);
    }),
  );
}

async function start(context: vscode.ExtensionContext, status: StatusBar): Promise<void> {
  session?.dispose();
  session = undefined;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    status.dormant("no folder is open");
    return;
  }

  const cwd = folder.uri.fsPath;
  if (!(await isRepo(cwd))) {
    log.info(`${cwd} is not a git repository — staying dormant`);
    status.dormant("this folder is not a git repository");
    return;
  }

  const repo = await readRepoContext(cwd);
  const settings = (): Settings => readSettings(repo.root);

  if (!settings().enabled) {
    log.info("Disabled via crTrack.enabled");
    status.dormant("disabled in settings");
    return;
  }

  const gate = await checkStartup(context, settings().claudePath);
  if (!gate.ready || !gate.claudePath) {
    status.dormant(gate.reason ?? "the Claude CLI is unavailable");
    return;
  }

  const orchestrator = new Orchestrator(repo.root, gate.claudePath, settings);
  const diagnostics = new DiagnosticsView(repo.root);
  const watcher = new IndexWatcher(
    repo.root,
    () => settings().debounceMs,
    () => {
      void orchestrator.review().catch((err) => log.error("Review threw", err));
    },
  );

  session = new Session(repo.root, orchestrator, diagnostics, status, watcher);
  status.update(orchestrator.state);
  log.info(`Active on ${repo.name} (${repo.branch})`);

  // Review whatever is already staged, so the extension is useful immediately
  // rather than only after the next `git add`.
  void orchestrator.review().catch((err) => log.error("Initial review threw", err));
}

function registerCommands(context: vscode.ExtensionContext, status: StatusBar): void {
  const register = (id: string, fn: () => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("crTrack.reviewStaged", async () => {
    if (!session) {
      void vscode.window.showWarningMessage("CR-Track is inactive. See the log for why.");
      log.show();
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: "CR-Track: reviewing…" },
      () => session!.orchestrator.review({ force: true }),
    );
  });

  register("crTrack.cancelReview", () => {
    session?.orchestrator.cancelInFlight();
    if (session) status.update(session.orchestrator.state);
  });

  register("crTrack.clearFindings", () => {
    session?.orchestrator.reset();
    session?.diagnostics.clear();
  });

  register("crTrack.showOutput", () => log.show());
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}
