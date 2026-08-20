/**
 * CR-Track.
 *
 * One job, two halves: when a commit lands, review what was in it, show the
 * developer what could be better, and send the outcome to the dashboard.
 *
 * Everything here is subordinate to that. Earlier versions grew a file
 * reviewer, a commit gate, a setup walkthrough and a working-tree mode. None of
 * it served the trigger the product is about, and each addition was one more
 * way for the thing to be broken on someone else's machine.
 */

import * as vscode from "vscode";
import { readEndpoint, readSettings, type Settings } from "./config";
import { CommitWatcher } from "./commit-watcher";
import { DiagnosticsView } from "./diagnostics";
import { initLog, log } from "./log";
import { checkStartup, clearStartupCache } from "./startup";
import { StatusBar } from "./status";
import { FindingsTree } from "./tree";
import {
  checkRepo,
  commitDiff,
  commitStats,
  gitPath,
  headSha,
  isDubiousOwnership,
  locateGit,
  readCommit,
  readRepoContext,
  setGitPath,
  trustDirectory,
  type CommitInfo,
} from "@engine/git";
import { isReviewableCode } from "@engine/languages";
import { findReferencesDir } from "@engine/prompt";
import { killAllChildren } from "@engine/proc";
import { buildReport } from "@engine/report";
import { runReview } from "@engine/review";
import { deliver, flushQueue } from "@engine/telemetry";
import type { DiffStats, Finding, RepoContext } from "@engine/types";

let session: Session | undefined;

/** Live while a repository and a usable Claude CLI are both present. */
class Session implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private reviewing = false;

  constructor(
    readonly repo: RepoContext,
    readonly claudePath: string,
    readonly cliVersion: string | undefined,
    readonly extensionVersion: string,
    readonly referencesDir: string | null,
    readonly settings: () => Settings,
    readonly diagnostics: DiagnosticsView,
    readonly tree: FindingsTree,
    readonly status: StatusBar,
  ) {
    this.disposables.push(diagnostics, tree);
    this.disposables.push(
      new CommitWatcher(repo.root, (sha) => {
        void this.reviewCommit(sha).catch((err) => log.error("Commit review failed", err));
      }),
    );
  }

  /**
   * Review one commit, show the findings, and report them.
   *
   * Never throws and never blocks. The commit has already happened, so the
   * worst outcome available is a missing review — that must not escalate into
   * a broken editor.
   */
  async reviewCommit(sha: string): Promise<void> {
    if (this.reviewing) {
      log.info("A review is already running — skipping this one");
      return;
    }
    this.reviewing = true;
    const triggeredAt = new Date();

    try {
      const commit = await readCommit(this.repo.root, sha);
      if (!commit) {
        log.warn(`Could not read commit ${sha.slice(0, 8)}`);
        return;
      }
      // A merge's diff is everything both branches did. Reviewing it says
      // nothing about what this developer actually wrote.
      if (commit.parents > 1) {
        log.info(`${commit.shortSha} is a merge — skipping`);
        return;
      }

      const stats = await commitStats(this.repo.root, sha);
      const code = stats.files.filter((f) => isReviewableCode(f.path));
      if (code.length === 0) {
        log.info(`${commit.shortSha} touches no source files — skipping`);
        this.status.idle(`${commit.shortSha}: nothing to review`);
        return;
      }

      const diff = await commitDiff(
        this.repo.root,
        sha,
        code.map((f) => f.path),
      );
      if (!diff.trim()) {
        log.info(`${commit.shortSha} produced an empty diff — skipping`);
        return;
      }

      const cfg = this.settings();
      log.info(
        `Reviewing ${commit.shortSha} (${commit.subject}) — ` +
          `${code.length} file(s), +${stats.linesAdded}/-${stats.linesRemoved}`,
      );
      this.status.busy(`Reviewing commit ${commit.shortSha}`);

      const result = await runReview({
        claudePath: this.claudePath,
        repoRoot: this.repo.root,
        diff,
        changedPaths: code.map((f) => f.path),
        config: cfg,
        referencesDir: this.referencesDir,
      });

      if (result.error) {
        log.warn(`Review failed: ${result.error}`);
        this.status.failed(result.error);
        return;
      }

      // Half one: show the developer what could be better.
      this.diagnostics.show(result.findings);
      this.tree.setFindings(result.findings);
      this.status.reviewed(result.findings.length, commit.shortSha);
      log.info(
        `${commit.shortSha}: ${result.findings.length} finding(s) in ` +
          `${(result.durationMs / 1000).toFixed(0)}s`,
      );
      if (result.findings.length > 0) {
        void vscode.commands.executeCommand("crTrack.findings.focus");
      }

      // Half two: send the outcome to the dashboard.
      await this.report(commit, stats, result.findings, triggeredAt, result.durationMs, cfg);
    } finally {
      this.reviewing = false;
    }
  }

  private async report(
    commit: CommitInfo,
    stats: DiffStats,
    findings: Finding[],
    triggeredAt: Date,
    durationMs: number,
    cfg: Settings,
  ): Promise<void> {
    try {
      const { report, redactionHits } = buildReport({
        repo: { ...this.repo, head: commit.sha, headShort: commit.shortSha },
        stats,
        findings,
        annotations: [],
        outcomes: new Map(),
        scope: "committed",
        model: cfg.model,
        effort: cfg.effort,
        durationMs,
        triggeredAt,
        completedAt: new Date(),
        extensionVersion: this.extensionVersion,
        ...(this.cliVersion ? { cliVersion: this.cliVersion } : {}),
      });

      // The commit is the unit the dashboard measures, so it travels with the
      // report rather than being inferred from a branch name later.
      (report.review as unknown as Record<string, unknown>)["commit"] = {
        sha: commit.sha,
        shortSha: commit.shortSha,
        message: commit.subject,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        authoredAt: commit.authoredAt,
      };

      if (redactionHits.length) log.info(`Redacted: ${redactionHits.join(", ")}`);

      const endpoint = readEndpoint(this.repo.root);
      const token = process.env["CR_TRACK_INGEST_TOKEN"];
      const result = await deliver(this.repo.root, report, {
        ...(endpoint ? { endpoint } : {}),
        ...(token ? { token } : {}),
      });

      log.info(
        result.uploaded
          ? `Report sent to the dashboard (${result.status})`
          : result.queued
            ? `Dashboard unreachable (${result.detail ?? result.status}) — queued for retry`
            : `Report written locally (${result.detail ?? "no endpoint configured"})`,
      );
    } catch (err) {
      log.error("Reporting failed", err);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());
  log.info(`CR-Track ${context.extension?.packageJSON?.version ?? ""} activating`);

  const status = new StatusBar();
  context.subscriptions.push(status);
  registerCommands(context, status);

  await start(context, status);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("crTrack")) {
        clearStartupCache();
        await start(context, status);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void start(context, status)),
  );
}

/** Rechecks while inactive, so a fix applied later is noticed without a reload. */
let recovery: vscode.Disposable | undefined;
let lastRecheck = 0;
let pendingRecheck: NodeJS.Timeout | undefined;
let starting = false;
let lastDormant: string | undefined;
const RECHECK_MS = 15_000;

function disarmRecovery(): void {
  recovery?.dispose();
  recovery = undefined;
  if (pendingRecheck) {
    clearTimeout(pendingRecheck);
    pendingRecheck = undefined;
  }
}

function requestRecheck(context: vscode.ExtensionContext, status: StatusBar, why: string): void {
  if (session || starting) return;
  const waited = Date.now() - lastRecheck;
  if (waited < RECHECK_MS) {
    // These triggers are edges: `.git/HEAD` appears exactly once. Dropping a
    // suppressed call would lose it for good, so defer it instead.
    if (!pendingRecheck) {
      pendingRecheck = setTimeout(() => {
        pendingRecheck = undefined;
        requestRecheck(context, status, why);
      }, RECHECK_MS - waited);
    }
    return;
  }
  lastRecheck = Date.now();
  log.info(`${why} — rechecking`);
  void start(context, status).catch((err) => log.error("Recheck failed", err));
}

function armRecovery(context: vscode.ExtensionContext, status: StatusBar, folder?: string): void {
  disarmRecovery();
  const parts: vscode.Disposable[] = [];
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(folder), ".git/HEAD"),
    );
    watcher.onDidCreate(() => requestRecheck(context, status, "A repository appeared"));
    parts.push(watcher);
  }
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
  } catch (err) {
    log.error("Startup failed", err);
    status.dormant("startup failed — see the log");
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
    armRecovery(context, status);
    return;
  }
  const cwd = folder.uri.fsPath;

  // Look where the editor looks, then where git actually installs. A window
  // that did not inherit git on PATH still has a working Source Control panel.
  const override = gitOverrideSetting();
  const foundGit = await locateGit(override);
  if (foundGit) log.info(`Git ${foundGit.version} at ${foundGit.path}`);
  else setGitPath(override);

  let repoCheck = await checkRepo(cwd);
  if (!repoCheck.ok && isDubiousOwnership(repoCheck.detail)) {
    const choice = await vscode.window.showWarningMessage(
      `CR-Track: git will not open ${cwd} — it is owned by another user account.`,
      "Trust this folder",
    );
    if (choice === "Trust this folder" && (await trustDirectory(cwd))) {
      repoCheck = await checkRepo(cwd);
    }
  }

  if (!repoCheck.ok) {
    const summary =
      repoCheck.reason === "not-a-repo" ? "no git repository here" : "git could not be used";
    // Log a reason once per distinct cause; repeating it on every recheck
    // buries everything else and reads like a fault in itself.
    const fingerprint = `${cwd}|${repoCheck.reason}`;
    if (lastDormant !== fingerprint) {
      lastDormant = fingerprint;
      log.warn(`${cwd}: ${summary}`);
      log.info(`  git = ${gitPath()}`);
      log.info(`  ${repoCheck.detail}`);
    }
    status.dormant(summary);
    armRecovery(context, status, cwd);
    return;
  }

  const repo = await readRepoContext(cwd);
  const settings = (): Settings => readSettings(repo.root);

  if (!settings().enabled) {
    log.info("Disabled via crTrack.enabled");
    status.dormant("disabled in settings");
    disarmRecovery();
    return;
  }

  const gate = await checkStartup(context, settings().claudePath);
  if (!gate.ready || !gate.claudePath) {
    status.dormant(gate.reason ?? "the Claude CLI is unavailable");
    armRecovery(context, status, cwd);
    return;
  }

  const referencesDir = findReferencesDir(context.extensionUri.fsPath);
  if (referencesDir) log.info(`Guides: ${referencesDir}`);
  else log.warn("Guides not found — findings will be weaker than they should be");

  session = new Session(
    repo,
    gate.claudePath,
    gate.version,
    context.extension?.packageJSON?.version ?? "0.0.0",
    referencesDir,
    settings,
    new DiagnosticsView(repo.root),
    new FindingsTree(repo.root),
    status,
  );

  disarmRecovery();
  lastDormant = undefined;
  status.idle(`watching ${repo.name} for commits`);
  log.info(`Active on ${repo.name} (${repo.branch}) — every new commit will be reviewed`);

  const endpoint = readEndpoint(repo.root);
  if (endpoint) {
    const token = process.env["CR_TRACK_INGEST_TOKEN"];
    void flushQueue(repo.root, { endpoint, ...(token ? { token } : {}) })
      .then(({ sent, remaining }) => {
        if (sent || remaining) log.info(`Report queue: sent ${sent}, ${remaining} remaining`);
      })
      .catch((err) => log.error("Queue flush failed", err));
  } else {
    log.info("No dashboard endpoint configured — reports stay in .cr-track/");
  }
}

/** The git binary the user has already told the editor about, if any. */
function gitOverrideSetting(): string | string[] | undefined {
  const own = vscode.workspace.getConfiguration("crTrack").get<string>("gitPath")?.trim();
  if (own) return own;
  return vscode.workspace.getConfiguration("git").get<string | string[] | null>("path") ?? undefined;
}

function registerCommands(context: vscode.ExtensionContext, status: StatusBar): void {
  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("crTrack.reviewLastCommit", async () => {
    if (!session) await start(context, status);
    if (!session) {
      const choice = await vscode.window.showWarningMessage(
        "CR-Track is inactive here.",
        "Diagnose",
      );
      if (choice === "Diagnose") await vscode.commands.executeCommand("crTrack.diagnose");
      return;
    }
    const active = session;
    // Read HEAD now rather than trusting the value captured at activation —
    // by definition the developer has committed since then.
    const sha = (await headSha(active.repo.root)) || active.repo.head;
    if (!sha) {
      void vscode.window.showInformationMessage("CR-Track: this repository has no commits yet.");
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CR-Track: reviewing the last commit",
      },
      () => active.reviewCommit(sha),
    );
  });

  register("crTrack.showOutput", () => log.show());

  register("crTrack.clearFindings", () => {
    session?.diagnostics.clear();
    session?.tree.clear();
  });

  register("crTrack.diagnose", async () => {
    log.show();
    log.info("──────── diagnostics ────────");
    const folder = vscode.workspace.workspaceFolders?.[0];
    log.info(`folder     : ${folder?.uri.fsPath ?? "(none)"}`);
    log.info(`active     : ${session ? "yes" : "no"}`);
    log.info(`extension  : ${context.extension?.packageJSON?.version ?? "?"}`);
    log.info(`vscode     : ${vscode.version} on ${process.platform}`);

    // Resolve the same way startup does — and mutate nothing, because this is
    // the command someone runs when things are already going wrong.
    const resolved = await locateGit(gitOverrideSetting());
    log.info(`git        : ${gitPath()}${resolved ? ` (v${resolved.version})` : " — NOT USABLE"}`);

    if (folder) {
      const check = await checkRepo(folder.uri.fsPath);
      log.info(`repository : ${check.ok ? "yes" : `NO — ${check.detail}`}`);
    }
    const cfg = readSettings(folder?.uri.fsPath);
    const gate = await checkStartup(context, cfg.claudePath);
    log.info(
      `claude cli : ${gate.ready ? `${gate.version} at ${gate.claudePath}` : `NO — ${gate.reason}`}`,
    );
    log.info(`guides     : ${findReferencesDir(context.extensionUri.fsPath) ?? "NOT FOUND"}`);
    log.info(`dashboard  : ${readEndpoint(folder?.uri.fsPath) ?? "(none — reports stay local)"}`);
    log.info(`model      : ${cfg.model} / effort ${cfg.effort}`);
    log.info("─────────────────────────────");
  });

  register("crTrack.revealFinding", async (arg: unknown) => {
    const node = arg as { kind?: string; finding?: Finding } | undefined;
    const finding = node?.kind === "finding" ? node.finding : undefined;
    if (!finding || !session) return;
    try {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(session.repo.root), finding.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const line = Math.max(0, Math.min(doc.lineCount - 1, (finding.lineStart || 1) - 1));
      const range = new vscode.Range(line, 0, line, doc.lineAt(line).text.length);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.end);
    } catch {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }
  });
}

export function deactivate(): void {
  disarmRecovery();
  session?.dispose();
  session = undefined;
  // Windows will not remove the extension directory while a process we started
  // is still alive, which is why an uninstall could fail. Nothing we spawned
  // outlives the window now.
  killAllChildren();
}
