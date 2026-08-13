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
import { checkStartup, clearStartupCache } from "./startup";
import { StatusBar } from "./status";
import { FindingsTree } from "./tree";
import { IndexWatcher } from "./watcher";
import {
  checkRepo, gitPath, initRepository, isDubiousOwnership, locateGit, readRepoContext,
  setGitPath, trustDirectory,
} from "@engine/git";
import { findReferencesDir } from "@engine/prompt";
import { collectFiles, synthesizeDiff } from "@engine/files";
import { runReview } from "@engine/review";
import type { Finding, RepoContext } from "@engine/types";
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

/** The half of the extension that genuinely needs a git repository. */
interface GitFeatures {
  repo: RepoContext;
  orchestrator: Orchestrator;
  watcher: IndexWatcher;
}

/** Everything that exists once a folder and a usable CLI are present. */
class Session implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    /** Repo root when there is one, otherwise the open folder. */
    readonly repoRoot: string,
    readonly diagnostics: DiagnosticsView,
    readonly status: StatusBar,
    readonly fixes: FixProvider,
    readonly tree: FindingsTree,
    readonly settings: () => Settings,
    readonly claudePath: string,
    readonly cliVersion: string | undefined,
    readonly extensionVersion: string,
    readonly referencesDir: string | null,
    /** Absent when the folder is not a git repository. */
    readonly git: GitFeatures | undefined,
  ) {
    this.disposables.push(diagnostics, fixes, tree);
    if (git) {
      this.disposables.push(git.orchestrator, git.watcher);
      this.disposables.push(
        git.orchestrator.onDidChangeState((state) => {
          status.update(state);
          this.render(state);
        }),
      );
    }
  }

  get orchestrator(): Orchestrator | undefined {
    return this.git?.orchestrator;
  }

  /**
   * Review complete files, with no git involved.
   *
   * This is the path that keeps the extension useful in a folder that is not a
   * repository — a downloaded project, a scratch directory, anything a
   * colleague sent over. It reuses the engine wholesale; only the trigger and
   * the prompt's framing differ.
   */
  async reviewFiles(absPaths: string[]): Promise<void> {
    const { files, skipped } = collectFiles(absPaths, this.repoRoot);

    for (const s of skipped) log.info(`Skipped ${s.path} — ${s.reason}`);
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        skipped.length
          ? `CR-Track: nothing reviewable there (${skipped[0]?.reason}).`
          : "CR-Track: nothing to review.",
      );
      return;
    }

    const cfg = this.settings();
    const label = files.length === 1 ? files[0]!.path : `${files.length} files`;
    log.info(`Reviewing ${label} as complete file(s) (${cfg.model}, effort ${cfg.effort})`);
    this.status.busy(`Reviewing ${label}…`);

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `CR-Track: reviewing ${label}…`, cancellable: true },
        (_p, token) =>
          runReview({
            claudePath: this.claudePath,
            repoRoot: this.repoRoot,
            diff: synthesizeDiff(files),
            changedPaths: files.map((f) => f.path),
            config: cfg,
            referencesDir: this.referencesDir,
            mode: "files",
            // Defensive: losing cancellation is a missing convenience, but an
            // exception here would abort the review entirely.
            onSpawn: (kill) => {
              try {
                token?.onCancellationRequested?.(() => kill());
              } catch {
                /* no cancellation available — the review still runs */
              }
            },
          }),
      );

      if (result.error) {
        log.warn(`File review failed: ${result.error}`);
        this.status.failed(result.error);
        void vscode.window.showWarningMessage(`CR-Track: ${result.error}`, "Show log")
          .then((c) => c === "Show log" && log.show());
        return;
      }

      this.fixes.reset();
      this.diagnostics.show(result.findings);
      this.tree.setFindings(result.findings);
      this.status.fileReview(result.findings, label);
      log.info(
        `File review complete in ${(result.durationMs / 1000).toFixed(0)}s — ` +
          `${result.findings.length} finding(s)`,
      );
      if (result.findings.length > 0) {
        void vscode.commands.executeCommand("workbench.view.extension.crTrackContainer");
      } else {
        void vscode.window.showInformationMessage(`CR-Track: no findings in ${label}.`);
      }
    } catch (err) {
      log.error("File review threw", err);
      this.status.failed((err as Error).message);
    }
  }

  /**
   * Assemble and deliver the report for the current review.
   *
   * Never throws and never blocks: a dashboard being down must not be able to
   * interrupt a commit.
   */
  async report(overrideReason?: string): Promise<void> {
    const state = this.git?.orchestrator.state;
    if (!state || state.kind !== "done") return;
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
        clearStartupCache();
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
/**
 * The single source of truth for which git to use. Startup and Diagnose must
 * resolve it identically — when they did not, Diagnose reset the discovered
 * path to a bare "git", reported a working repository as missing, and left
 * every later git call in the session broken.
 */
function gitOverrideSetting(): string | string[] | undefined {
  const own = vscode.workspace.getConfiguration("crTrack").get<string>("gitPath")?.trim();
  if (own) return own;
  const fromGitExt = vscode.workspace
    .getConfiguration("git")
    .get<string | string[] | null>("path");
  return fromGitExt ?? undefined;
}

let recovery: vscode.Disposable | undefined;
let lastRecheck = 0;
/** A deferred recheck for an edge that arrived inside the throttle window. */
let pendingRecheck: NodeJS.Timeout | undefined;
/** Guards against overlapping starts; two rechecks a millisecond apart stack. */
let starting = false;
/** The last dormant reason logged, so an unchanged state stays quiet. */
let lastDormantReason: string | undefined;

const RECHECK_INTERVAL_MS = 15_000;

function disarmRecovery(): void {
  recovery?.dispose();
  recovery = undefined;
  if (pendingRecheck) {
    clearTimeout(pendingRecheck);
    pendingRecheck = undefined;
  }
}

/**
 * Every recovery trigger funnels through here.
 *
 * The first version throttled only the focus handler, so the file watcher could
 * re-enter `start()` without limit — a folder that is legitimately not a
 * repository produced an endless recheck loop, visible as the same three log
 * lines repeating forever. Throttling one caller is not throttling.
 */
function requestRecheck(
  context: vscode.ExtensionContext,
  status: StatusBar,
  why: string,
): void {
  // `session?.git`, not `session`. A file-review session exists in a folder
  // that is not a repository, and that is exactly the case we still want to
  // recover from when `git init` runs.
  if (session?.git || starting) return;
  const now = Date.now();
  const waited = now - lastRecheck;
  if (waited < RECHECK_INTERVAL_MS) {
    // The triggers are edges, not levels: `.git/HEAD` is created exactly once
    // by `git init`. Dropping a suppressed call loses that edge forever, so
    // defer it to the end of the window instead.
    if (!pendingRecheck) {
      pendingRecheck = setTimeout(() => {
        pendingRecheck = undefined;
        requestRecheck(context, status, why);
      }, RECHECK_INTERVAL_MS - waited);
    }
    return;
  }
  lastRecheck = now;
  log.info(`${why} — rechecking`);
  void start(context, status).catch((err) => log.error("Recheck failed", err));
}

function armRecovery(
  context: vscode.ExtensionContext,
  status: StatusBar,
  folderPath: string | undefined,
): void {
  disarmRecovery();
  const parts: vscode.Disposable[] = [];

  if (folderPath) {
    // `.git/HEAD` is created by `git init` and by `git clone`, and unlike the
    // directory itself it is a file the watcher reliably reports.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(folderPath), ".git/HEAD"),
    );
    watcher.onDidCreate(() => requestRecheck(context, status, "A git repository appeared"));
    watcher.onDidChange(() => requestRecheck(context, status, "The git repository changed"));
    parts.push(watcher);
  }

  // Catches everything a file watcher cannot see — a CLI installed in another
  // terminal, a `claude` login.
  parts.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) requestRecheck(context, status, "Window focused while inactive");
    }),
  );

  recovery = vscode.Disposable.from(...parts);
}

async function start(context: vscode.ExtensionContext, status: StatusBar): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    await startInner(context, status);
  } finally {
    starting = false;
  }
}

async function startInner(context: vscode.ExtensionContext, status: StatusBar): Promise<void> {
  session?.dispose();
  session = undefined;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    status.dormant("no folder is open");
    armRecovery(context, status, undefined);
    return;
  }

  // Find a git we can actually run: explicit setting, then VS Code's own
  // git.path, then PATH, then the places git installs to. Source Control
  // working while CR-Track claims "no repository" means we looked in fewer
  // places than the editor did.
  const gitOverride = gitOverrideSetting();
  const foundGit = await locateGit(gitOverride);
  if (foundGit) {
    log.info(`Git ${foundGit.version} at ${foundGit.path}`);
  } else {
    setGitPath(gitOverride);
    log.warn("No usable git found on PATH or in the usual install locations");
  }

  const cwd = folder.uri.fsPath;
  let repoCheck = await checkRepo(cwd);

  // Windows refuses repositories owned by another user. One command fixes it,
  // so offer that instead of reporting a dead end.
  if (!repoCheck.ok && isDubiousOwnership(repoCheck.detail)) {
    log.warn(`Git refused ${cwd} as owned by another user`);
    const choice = await vscode.window.showWarningMessage(
      `CR-Track: git will not open ${cwd} because it is owned by another user account.`,
      "Trust this folder",
      "Show log",
    );
    if (choice === "Trust this folder") {
      const ok = await trustDirectory(cwd);
      log.info(ok ? `Added ${cwd} to git safe.directory` : "Could not update safe.directory");
      if (ok) repoCheck = await checkRepo(cwd);
    } else if (choice === "Show log") {
      log.show();
    }
  }

  // A failed repo check no longer ends the startup. Git decides *what* to
  // review; it was never supposed to decide *whether* CR-Track can review at
  // all. Without a repository the extension loses staged reviews and the
  // commit gate, and keeps file review — which is the difference between
  // "limited here" and "does nothing here".
  const hasRepo = repoCheck.ok;
  if (!hasRepo) {
    const summary =
      repoCheck.reason === "git-missing"
        ? "git could not be run"
        : repoCheck.reason === "git-error"
          ? "git reported a problem"
          : "no git repository";
    // Log the reason once. Repeating it on every recheck buries everything
    // else in the output channel and reads like a fault in itself.
    const fingerprint = `${cwd}|${repoCheck.reason}`;
    if (lastDormantReason !== fingerprint) {
      lastDormantReason = fingerprint;
      log.warn(`${cwd}: ${summary}`);
      log.info(`  git = ${gitPath()}`);
      log.info(`  ${repoCheck.detail}`);
      log.info(
        repoCheck.reason === "not-a-repo"
          ? '  Staged review and the commit gate need a repository. File review still ' +
            'works: right-click a file or folder and choose "CR-Track: Review". ' +
            'To enable the rest, use "CR-Track: Initialize Repository".'
          : '  Run "CR-Track: Diagnose" for the full picture, then "CR-Track: Restart".',
      );
    }
  }
  void vscode.commands.executeCommand("setContext", "crTrack.noRepo", !hasRepo);

  const repo = hasRepo ? await readRepoContext(cwd) : undefined;
  const root = repo?.root ?? cwd;
  const settings = (): Settings => readSettings(root);

  if (!settings().enabled) {
    log.info("Disabled via crTrack.enabled");
    status.dormant("disabled in settings");
    disarmRecovery(); // an explicit opt-out should stay opted out
    return;
  }

  // The CLI is required for any review at all, repository or not.
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

  const diagnostics = new DiagnosticsView(root);
  const fixes = new FixProvider(diagnostics);
  const tree = new FindingsTree(root, fixes);

  // Git-backed features, only when there is a repository to back them.
  let gitFeatures: GitFeatures | undefined;
  if (repo) {
    const orchestrator = new Orchestrator(repo.root, gate.claudePath, settings, referencesDir);
    const watcher = new IndexWatcher(
      repo.root,
      () => settings().debounceMs,
      () => {
        // A new staged set invalidates the previous review's outcomes.
        fixes.reset();
        void orchestrator.review().catch((err) => log.error("Review threw", err));
      },
    );
    gitFeatures = { repo, orchestrator, watcher };
  }

  session = new Session(
    root,
    diagnostics,
    status,
    fixes,
    tree,
    settings,
    gate.claudePath,
    gate.version,
    context.extension?.packageJSON?.version ?? "0.0.0",
    referencesDir,
    gitFeatures,
  );

  void vscode.commands.executeCommand("setContext", "crTrack.active", true);

  if (repo && gitFeatures) {
    disarmRecovery(); // fully running; nothing left to wait for
    lastDormantReason = undefined;
    status.update(gitFeatures.orchestrator.state);
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
  } else {
    // Partly available: say which half works instead of reporting a dead end.
    status.limited("no git repository — file review still works");
    log.info("File review is available; staged review and the commit gate are not.");
    armRecovery(context, status, cwd);
    return;
  }

  // Review whatever is already staged, so the extension is useful immediately
  // rather than only after the next `git add`.
  void gitFeatures.orchestrator.review().catch((err) => log.error("Initial review threw", err));
}

/**
 * Guard for the commands that genuinely need a repository. Returns the git
 * bundle, or explains what is missing and offers the way out.
 */
async function requireGit(): Promise<NonNullable<Session["git"]> | undefined> {
  if (session?.git) return session.git;
  const choice = await vscode.window.showWarningMessage(
    session
      ? "CR-Track: this needs a git repository. Reviewing individual files still works."
      : "CR-Track is inactive. See the log for why.",
    ...(session ? ["Initialise a repository", "Review a file instead", "Show log"] : ["Show log"]),
  );
  if (choice === "Initialise a repository") {
    await vscode.commands.executeCommand("crTrack.initRepository");
  } else if (choice === "Review a file instead") {
    await vscode.commands.executeCommand("crTrack.reviewFile");
  } else if (choice === "Show log") {
    log.show();
  }
  return undefined;
}

function registerCommands(context: vscode.ExtensionContext, status: StatusBar): void {
  // Handlers invoked from a tree view or code action receive arguments; those
  // invoked from the palette receive none. Accept both.
  const register = (id: string, fn: (...args: any[]) => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("crTrack.reviewStaged", async () => {
    // Asking for a review is the moment to retry startup — most causes clear
    // on a recheck.
    if (!session?.git) await start(context, status);
    const git = await requireGit();
    if (!git) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: "CR-Track: reviewing…" },
      () => git.orchestrator.review({ force: true }),
    );
  });

  // ── file review: works with or without a repository ───────────────────
  register("crTrack.reviewFile", async (uri?: vscode.Uri) => {
    if (!session) {
      await start(context, status);
      if (!session) {
        void vscode.window.showWarningMessage("CR-Track is inactive. See the log for why.");
        log.show();
        return;
      }
    }
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== "file") {
      void vscode.window.showInformationMessage(
        "CR-Track: open a file, or right-click one in the Explorer.",
      );
      return;
    }
    await session.reviewFiles([target.fsPath]);
  });

  register("crTrack.reviewFolder", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
    if (!session) {
      await start(context, status);
      if (!session) {
        void vscode.window.showWarningMessage("CR-Track is inactive. See the log for why.");
        log.show();
        return;
      }
    }
    // Multi-select in the Explorer hands over the full selection.
    const roots = (selected?.length ? selected : uri ? [uri] : []).filter((u) => u.scheme === "file");
    if (roots.length === 0) {
      void vscode.window.showInformationMessage("CR-Track: right-click a file or folder to review it.");
      return;
    }
    const paths = await expandPaths(roots);
    if (paths.length === 0) {
      void vscode.window.showInformationMessage("CR-Track: no reviewable source files in that selection.");
      return;
    }
    await session.reviewFiles(paths);
  });

  register("crTrack.reviewAndCommit", async () => {
    const git = session?.git;
    if (!git) {
      // Refusing to commit would be worse than not reviewing — but committing
      // in silence lets someone believe a review happened when none did.
      log.warn("Review & Commit ran with no repository-backed session; committing unreviewed");
      void vscode.window.showWarningMessage(
        "CR-Track could not review this commit — it is inactive here. Committing anyway.",
        "Why?",
      ).then((c) => c === "Why?" && vscode.commands.executeCommand("crTrack.diagnose"));
      await runGitCommit();
      return;
    }

    // Make sure we are judging the current staged set, not a stale one.
    if (git.orchestrator.state.kind !== "done") {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "CR-Track: reviewing…" },
        () => git.orchestrator.review(),
      );
    }

    // Captured before the awaits above: a recheck could replace `session`.
    const active = session;
    if (!active) return;

    const decision = await askBeforeCommit(active.diagnostics.remaining(), {
      blockOnBlocking: active.settings().blockCommitOnBlocking,
    });
    if (!decision.proceed) return;

    const committed = await runGitCommit();
    if (committed) await active.report(decision.overrideReason);
  });

  register("crTrack.reviewWorkingTree", async () => {
    const git = await requireGit();
    if (!git) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: "CR-Track: reviewing working tree…" },
      () => git.orchestrator.review({ force: true, scope: "all" }),
    );
    if (git.orchestrator.state.kind === "idle") {
      void vscode.window.showInformationMessage("CR-Track: no changes to review.");
    }
  });

  register("crTrack.cancelReview", () => {
    session?.git?.orchestrator.cancelInFlight();
    if (session?.git) status.update(session.git.orchestrator.state);
  });

  register("crTrack.clearFindings", () => {
    session?.git?.orchestrator.reset();
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
    clearStartupCache();
    await start(context, status);
    if (!session) {
      void vscode.window
        .showWarningMessage("CR-Track is still inactive. The log says why.", "Show log")
        .then((c) => c === "Show log" && log.show());
    }
  });

  // One command that answers "why isn't it working" on someone else's machine.
  register("crTrack.diagnose", async () => {
    log.show();
    log.info("──────── diagnostics ────────");
    const folder = vscode.workspace.workspaceFolders?.[0];
    log.info(`folder        : ${folder?.uri.fsPath ?? "(none open)"}`);
    log.info(`session       : ${session ? "ACTIVE" : "inactive"}`);
    log.info(`extension     : ${context.extension?.packageJSON?.version ?? "?"}`);
    log.info(`vscode        : ${vscode.version}`);
    log.info(`platform      : ${process.platform} ${process.arch}, node ${process.version}`);

    // Deliberately NOT setGitPath(): this command exists to explain a broken
    // state, and resetting the discovered path would both misreport the cause
    // and break every git call for the rest of the session.
    const resolved = await locateGit(gitOverrideSetting());
    log.info(`git binary    : ${gitPath()}${resolved ? ` (v${resolved.version})` : " — NOT USABLE"}`);
    log.info(`git override  : ${JSON.stringify(gitOverrideSetting()) ?? "(none)"}`);
    if (folder) {
      const check = await checkRepo(folder.uri.fsPath);
      log.info(`git repo      : ${check.ok ? "yes" : `NO — ${check.reason}`}`);
      if (!check.ok) log.info(`  ${check.detail}`);
    }

    const cfg = readSettings(folder?.uri.fsPath);
    clearStartupCache();
    const gate = await checkStartup(context, cfg.claudePath);
    log.info(`claude cli    : ${gate.ready ? `${gate.version} at ${gate.claudePath}` : `NOT USABLE — ${gate.reason}`}`);

    const guides = findReferencesDir(context.extensionUri.fsPath);
    log.info(`guides        : ${guides ?? "NOT FOUND — reviews would be much weaker"}`);
    log.info(`model/effort  : ${cfg.model} / ${cfg.effort}`);
    log.info(`endpoint      : ${readEndpoint(folder?.uri.fsPath) ?? "(none — reports stay local)"}`);
    log.info("─────────────────────────────");
    log.info('If anything above is wrong, fix it and run "CR-Track: Restart".');
  });

  register("crTrack.initRepository", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage("CR-Track: open a folder first.");
      return;
    }
    const dir = folder.uri.fsPath;
    const confirm = await vscode.window.showWarningMessage(
      `Initialise a git repository in ${dir}?`,
      { modal: true, detail: "Runs `git init`. Nothing is committed and no files are changed." },
      "Initialise",
    );
    if (confirm !== "Initialise") return;

    const ok = await initRepository(dir);
    if (ok) {
      log.info(`Initialised a git repository in ${dir}`);
      await start(context, status);
    } else {
      void vscode.window.showErrorMessage("CR-Track: `git init` failed. See the log.");
      log.show();
    }
  });

  register("crTrack.menu", async () => {
    const active = Boolean(session);
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(file-code) Review the current file", id: "crTrack.reviewFile" },
        { label: "$(search-fuzzy) Review staged changes", id: "crTrack.reviewStaged" },
        { label: "$(repo) Initialise a git repository here", id: "crTrack.initRepository" },
        { label: "$(git-compare) Review working tree", id: "crTrack.reviewWorkingTree" },
        { label: "$(list-tree) Open the Findings panel", id: "crTrack.focusView" },
        { label: "$(pulse) Diagnose", id: "crTrack.diagnose", description: "why isn't it working?" },
        { label: "$(refresh) Restart", id: "crTrack.restart" },
        { label: "$(output) Show log", id: "crTrack.showOutput" },
        { label: "$(gear) Settings", id: "crTrack.openSettings" },
      ],
      { title: `CR-Track — ${active ? "active" : "inactive"}`, placeHolder: "Choose an action" },
    );
    if (pick) await vscode.commands.executeCommand(pick.id);
  });

  register("crTrack.focusView", () => {
    void vscode.commands.executeCommand("workbench.view.extension.crTrackContainer");
  });

  register("crTrack.openSettings", () => {
    void vscode.commands.executeCommand("workbench.action.openSettings", "crTrack");
  });

  register("crTrack.showOutput", () => log.show());
}

/** Source extensions worth reviewing when a folder is selected. */
const REVIEWABLE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".kt", ".cs", ".rb", ".php", ".swift", ".c", ".h", ".cpp", ".hpp", ".sql",
  ".html", ".css", ".scss", ".vue", ".svelte",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".venv",
  "venv", "__pycache__", "vendor", "target", ".vercel", "coverage",
]);

/**
 * Expand a selection into reviewable files.
 *
 * Bounded deliberately: a folder review that swept node_modules would be slow,
 * expensive and useless. The cap is enforced again in the engine.
 */
async function expandPaths(roots: vscode.Uri[], limit = 40): Promise<string[]> {
  const out: string[] = [];

  const walk = async (uri: vscode.Uri, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 6) return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (out.length >= limit) return;
      if (name.startsWith(".") && type === vscode.FileType.Directory) continue;
      if (IGNORED_DIRS.has(name)) continue;
      const child = vscode.Uri.joinPath(uri, name);
      if (type === vscode.FileType.Directory) {
        await walk(child, depth + 1);
      } else if (REVIEWABLE.has(name.slice(name.lastIndexOf(".")).toLowerCase())) {
        out.push(child.fsPath);
      }
    }
  };

  for (const root of roots) {
    if (out.length >= limit) break;
    let stat: vscode.FileStat | undefined;
    try {
      stat = await vscode.workspace.fs.stat(root);
    } catch {
      continue;
    }
    if (stat.type === vscode.FileType.Directory) await walk(root, 0);
    else out.push(root.fsPath);
  }

  return out;
}

export function deactivate(): void {
  disarmRecovery();
  session?.dispose();
  session = undefined;
}
