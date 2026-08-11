/**
 * CR-Track — entry point.
 *
 * Wiring only: discover the repo, gate on the CLI, watch the index, and hand
 * results to the diagnostics view. Everything substantive lives in the engine
 * or in the modules beside this one.
 */

import * as vscode from "vscode";
import { askBeforeCommit, runGitCommit } from "./commit-gate";
import { readEndpoint, readSettings, type Settings } from "./config";
import { DiagnosticsView } from "./diagnostics";
import { FixProvider } from "./fixes";
import { initLog, log } from "./log";
import { Orchestrator, type State } from "./orchestrator";
import { checkStartup } from "./startup";
import { StatusBar } from "./status";
import { IndexWatcher } from "./watcher";
import { isRepo, readRepoContext } from "@engine/git";
import { buildReport, type FindingOutcome } from "@engine/report";
import { deliver, flushQueue } from "@engine/telemetry";

let session: Session | undefined;

/** Everything that exists only while a usable repo + CLI are present. */
class Session implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly repoRoot: string,
    readonly orchestrator: Orchestrator,
    readonly diagnostics: DiagnosticsView,
    readonly status: StatusBar,
    readonly fixes: FixProvider,
    readonly settings: () => Settings,
    readonly cliVersion: string | undefined,
    readonly extensionVersion: string,
    watcher: IndexWatcher,
  ) {
    this.disposables.push(orchestrator, diagnostics, fixes, watcher);

    this.disposables.push(
      orchestrator.onDidChangeState((state) => {
        status.update(state);
        this.render(state);
      }),
    );
  }

  /**
   * Assemble and deliver the report for the current review.
   *
   * Never throws and never blocks: a dashboard being down must not be able to
   * interrupt a commit.
   */
  async report(overrideReason?: string): Promise<void> {
    const state = this.orchestrator.state;
    if (state.kind !== "done") return;
    const { outcome } = state;

    try {
      const outcomes = new Map<string, FindingOutcome>();
      for (const [id, o] of this.fixes.allOutcomes()) {
        outcomes.set(id, { status: o.outcome, ...(o.reason ? { reason: o.reason } : {}) });
      }

      const cfg = this.settings();
      const completedAt = new Date();
      const { report, redactionHits } = buildReport({
        repo: outcome.repo,
        stats: outcome.stats,
        findings: outcome.findings,
        annotations: outcome.annotations,
        outcomes,
        scope: "staged",
        model: cfg.model,
        effort: cfg.effort,
        durationMs: outcome.durationMs,
        triggeredAt: new Date(completedAt.getTime() - outcome.durationMs),
        completedAt,
        ...(overrideReason ? { overrideReason } : {}),
        extensionVersion: this.extensionVersion,
        ...(this.cliVersion ? { cliVersion: this.cliVersion } : {}),
      });

      if (redactionHits.length) {
        log.info(`Redacted before writing: ${redactionHits.join(", ")}`);
      }

      const endpoint = readEndpoint(this.repoRoot);
      const result = await deliver(this.repoRoot, report, {
        ...(endpoint ? { endpoint } : {}),
        ...(process.env["CR_TRACK_INGEST_TOKEN"]
          ? { token: process.env["CR_TRACK_INGEST_TOKEN"] }
          : {}),
      });

      log.info(
        `Report written to ${result.localPath}` +
          (result.uploaded
            ? ` and uploaded (${result.status})`
            : result.queued
              ? ` — upload failed (${result.detail ?? result.status}), queued for retry`
              : ` (${result.detail ?? "not uploaded"})`),
      );
    } catch (err) {
      log.error("Report delivery failed", err);
    }
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
  const fixes = new FixProvider(diagnostics);
  const watcher = new IndexWatcher(
    repo.root,
    () => settings().debounceMs,
    () => {
      // A new staged set invalidates the previous review's outcomes.
      fixes.reset();
      void orchestrator.review().catch((err) => log.error("Review threw", err));
    },
  );

  session = new Session(
    repo.root,
    orchestrator,
    diagnostics,
    status,
    fixes,
    settings,
    gate.version,
    context.extension?.packageJSON?.version ?? "0.0.0",
    watcher,
  );
  status.update(orchestrator.state);
  log.info(`Active on ${repo.name} (${repo.branch})`);

  // Anything that failed to upload previously goes out now that we are back.
  const endpoint = readEndpoint(repo.root);
  if (endpoint) {
    void flushQueue(repo.root, {
      endpoint,
      ...(process.env["CR_TRACK_INGEST_TOKEN"]
        ? { token: process.env["CR_TRACK_INGEST_TOKEN"] }
        : {}),
    })
      .then(({ sent, remaining }) => {
        if (sent || remaining) log.info(`Report queue: sent ${sent}, ${remaining} remaining`);
      })
      .catch((err) => log.error("Queue flush failed", err));
  }

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

  register("crTrack.reviewAndCommit", async () => {
    if (!session) {
      // Without the extension, the ordinary commit is still the right outcome.
      await runGitCommit();
      return;
    }

    // Make sure we are judging the current staged set, not a stale one.
    if (session.orchestrator.state.kind !== "done") {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "CR-Track: reviewing…" },
        () => session!.orchestrator.review(),
      );
    }

    const outstanding = session.diagnostics.remaining();
    const decision = await askBeforeCommit(outstanding, {
      blockOnBlocking: session.settings().blockCommitOnBlocking,
    });
    if (!decision.proceed) return;

    const committed = await runGitCommit();
    if (committed) await session.report(decision.overrideReason);
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
