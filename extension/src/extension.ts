/**
 * CR-Track — entry point.
 *
 * Wiring only: discover the repo, gate on the CLI, watch the index, and hand
 * results to the diagnostics view. Everything substantive lives in the engine
 * or in the modules beside this one.
 */

import * as vscode from "vscode";
import { askBeforeCommit, reveal, runGitCommit } from "./commit-gate";
import { readEndpoint, readSettings, type Settings } from "./config";
import { DiagnosticsView } from "./diagnostics";
import { FixProvider } from "./fixes";
import { initLog, log } from "./log";
import { Orchestrator, type State } from "./orchestrator";
import { checkStartup } from "./startup";
import { StatusBar } from "./status";
import { FindingsTree } from "./tree";
import { IndexWatcher } from "./watcher";
import { isRepo, readRepoContext } from "@engine/git";
import { findReferencesDir } from "@engine/prompt";
import type { Finding } from "@engine/types";
import { buildReport, type FindingOutcome } from "@engine/report";
import { deliver, flushQueue } from "@engine/telemetry";

let session: Session | undefined;

/**
 * Tree-view menu commands arrive with the tree node; palette invocations may
 * arrive with the finding itself, or with nothing at all.
 */
function findingOf(arg: unknown): Finding | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const node = arg as { kind?: string; finding?: Finding; id?: string };
  if (node.kind === "finding" && node.finding) return node.finding;
  if (typeof node.id === "string" && "severity" in node) return node as unknown as Finding;
  return undefined;
}

/** Everything that exists only while a usable repo + CLI are present. */
class Session implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly repoRoot: string,
    readonly orchestrator: Orchestrator,
    readonly diagnostics: DiagnosticsView,
    readonly status: StatusBar,
    readonly fixes: FixProvider,
    readonly tree: FindingsTree,
    readonly settings: () => Settings,
    readonly cliVersion: string | undefined,
    readonly extensionVersion: string,
    watcher: IndexWatcher,
  ) {
    this.disposables.push(orchestrator, diagnostics, fixes, tree, watcher);

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
    void vscode.commands.executeCommand("setContext", "crTrack.nothingStaged",
      state.kind === "nothing-staged");

    if (state.kind === "done") {
      this.diagnostics.show(state.outcome.findings);
      this.tree.setFindings(state.outcome.findings);
    } else if (state.kind === "idle" || state.kind === "nothing-staged") {
      this.diagnostics.clear();
      this.tree.clear();
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

/**
 * Watchers that only exist while the extension is dormant, so it can notice
 * the world changing under it and come back on its own.
 *
 * Everything that stops the extension starting is temporary and fixable
 * without a reload: `git init` runs, the CLI gets installed, someone signs in.
 * Checking once at activation and never again means the fix appears to do
 * nothing and the extension looks broken.
 */
let recovery: vscode.Disposable | undefined;
let lastRecheck = 0;

function disarmRecovery(): void {
  recovery?.dispose();
  recovery = undefined;
}

function armRecovery(
  context: vscode.ExtensionContext,
  status: StatusBar,
  folderPath: string | undefined,
): void {
  disarmRecovery();
  const parts: vscode.Disposable[] = [];
  const restart = (why: string) => {
    log.info(`${why} — rechecking`);
    void start(context, status).catch((err) => log.error("Restart failed", err));
  };

  if (folderPath) {
    // `.git/HEAD` is created by `git init` and by `git clone`, and unlike the
    // directory itself it is a file the watcher reliably reports.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(folderPath), ".git/HEAD"),
    );
    watcher.onDidCreate(() => restart("A git repository appeared"));
    watcher.onDidChange(() => restart("The git repository changed"));
    parts.push(watcher);
  }

  // Catches everything a file watcher cannot see — a CLI installed in another
  // terminal, a `claude` login. Throttled, and only ever while dormant.
  parts.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused || session) return;
      const now = Date.now();
      if (now - lastRecheck < 15_000) return;
      lastRecheck = now;
      restart("Window focused while inactive");
    }),
  );

  recovery = vscode.Disposable.from(...parts);
}

async function start(context: vscode.ExtensionContext, status: StatusBar): Promise<void> {
  session?.dispose();
  session = undefined;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    status.dormant("no folder is open");
    armRecovery(context, status, undefined);
    return;
  }

  const cwd = folder.uri.fsPath;
  if (!(await isRepo(cwd))) {
    log.info(
      `${cwd} is not a git repository — staying dormant. ` +
        `Watching for one to appear; run "CR-Track: Restart" after \`git init\` if it does not.`,
    );
    status.dormant("this folder is not a git repository");
    armRecovery(context, status, cwd);
    return;
  }

  const repo = await readRepoContext(cwd);
  const settings = (): Settings => readSettings(repo.root);

  if (!settings().enabled) {
    log.info("Disabled via crTrack.enabled");
    status.dormant("disabled in settings");
    disarmRecovery(); // an explicit opt-out should stay opted out
    return;
  }

  const gate = await checkStartup(context, settings().claudePath);
  if (!gate.ready || !gate.claudePath) {
    status.dormant(gate.reason ?? "the Claude CLI is unavailable");
    armRecovery(context, status, cwd);
    return;
  }

  // Resolve the guide tree from the extension's own location. A packaged
  // extension has no monorepo above it, so this must find the copy the build
  // placed in resources/. Missing guides are survivable but materially worsen
  // the review, so say so loudly rather than degrading in silence.
  const referencesDir = findReferencesDir(context.extensionUri.fsPath);
  if (referencesDir) {
    log.info(`Guides: ${referencesDir}`);
  } else {
    log.warn(
      "Guides not found — reviewing with the base prompt only, without the ruleset " +
        "or any language guide. Findings will be noticeably weaker.",
    );
  }

  const orchestrator = new Orchestrator(repo.root, gate.claudePath, settings, referencesDir);
  const diagnostics = new DiagnosticsView(repo.root);
  const fixes = new FixProvider(diagnostics);
  const tree = new FindingsTree(repo.root, fixes);
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
    tree,
    settings,
    gate.version,
    context.extension?.packageJSON?.version ?? "0.0.0",
    watcher,
  );
  disarmRecovery(); // running now; nothing left to wait for
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
  // Handlers invoked from a tree view or code action receive arguments; those
  // invoked from the palette receive none. Accept both.
  const register = (id: string, fn: (...args: any[]) => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("crTrack.reviewStaged", async () => {
    if (!session) {
      // Offer the fix rather than only the diagnosis — most causes clear on a
      // recheck, and the user asking for a review is the moment to try.
      await start(context, status);
    }
    if (!session) {
      const choice = await vscode.window.showWarningMessage(
        "CR-Track is inactive — it could not start on this folder.",
        "Show log",
      );
      if (choice === "Show log") log.show();
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

  register("crTrack.reviewWorkingTree", async () => {
    if (!session) {
      void vscode.window.showWarningMessage("CR-Track is inactive. See the log for why.");
      log.show();
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: "CR-Track: reviewing working tree…" },
      () => session!.orchestrator.review({ force: true, scope: "all" }),
    );
    if (session.orchestrator.state.kind === "idle") {
      void vscode.window.showInformationMessage("CR-Track: no changes to review.");
    }
  });

  register("crTrack.cancelReview", () => {
    session?.orchestrator.cancelInFlight();
    if (session) status.update(session.orchestrator.state);
  });

  register("crTrack.clearFindings", () => {
    session?.orchestrator.reset();
    session?.diagnostics.clear();
    session?.tree.clear();
    session?.fixes.reset();
  });

  // ── Findings panel ────────────────────────────────────────────────────
  register("crTrack.revealFinding", async (arg: unknown) => {
    const finding = findingOf(arg);
    if (finding && session) await reveal(finding, session.repoRoot);
  });

  register("crTrack.acceptFinding", async (arg: unknown) => {
    const finding = findingOf(arg);
    if (!finding || !session) return;
    const uri = vscode.Uri.joinPath(vscode.Uri.file(session.repoRoot), finding.file);
    await vscode.commands.executeCommand("crTrack.applyFix", finding, uri);
  });

  register("crTrack.rejectFinding", async (arg: unknown) => {
    const finding = findingOf(arg);
    if (finding && session) await session.fixes.dismiss(finding);
  });

  register("crTrack.acceptAll", async () => {
    if (!session) return;
    const fixable = session.tree.outstanding().filter((f) => f.fix);
    if (fixable.length === 0) {
      void vscode.window.showInformationMessage(
        "CR-Track: nothing here has an automatic patch. Those findings need a human.",
      );
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Apply ${fixable.length} patch${fixable.length === 1 ? "" : "es"}?`,
      { modal: true, detail: "Each is checked against the current file first; any that no longer match are skipped." },
      "Apply all",
    );
    if (choice !== "Apply all") return;

    let applied = 0;
    for (const finding of fixable) {
      if (await session.fixes.applyQuiet(finding, session.repoRoot)) applied++;
    }
    void vscode.window.showInformationMessage(
      `CR-Track applied ${applied} of ${fixable.length} patch${fixable.length === 1 ? "" : "es"}.`,
    );
  });

  register("crTrack.rejectAll", async () => {
    if (!session) return;
    const open = session.tree.outstanding();
    if (open.length === 0) return;
    const choice = await vscode.window.showWarningMessage(
      `Reject all ${open.length} open finding(s)?`,
      { modal: true },
      "Reject all",
    );
    if (choice !== "Reject all") return;
    for (const finding of open) await session.fixes.dismiss(finding, false);
  });

  register("crTrack.restart", async () => {
    log.info("Restart requested");
    await start(context, status);
    if (!session) {
      void vscode.window
        .showWarningMessage("CR-Track is still inactive. The log says why.", "Show log")
        .then((c) => c === "Show log" && log.show());
    }
  });

  register("crTrack.showOutput", () => log.show());
}

export function deactivate(): void {
  disarmRecovery();
  session?.dispose();
  session = undefined;
}
