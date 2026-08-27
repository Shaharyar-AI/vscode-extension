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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { readEndpoint, readSettings, type Settings } from "./config";
import { CommitWatcher } from "./commit-watcher";
import { DiagnosticsView } from "./diagnostics";
import { initLog, log } from "./log";
import { checkStartup, clearStartupCache } from "./startup";
import { StatusBar } from "./status";
import { verifyFixes } from "@engine/verify";
import { reconcile } from "./reconcile";
// Re-exported so the test suite exercises the code that actually ships, rather
// than a separately compiled copy of it.
export { reconcile } from "./reconcile";
import { FindingsTree } from "./tree";
import {
  checkRepo,
  collectDiff,
  collectStats,
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
import { checkToken, deliver, flushQueue } from "@engine/telemetry";
import type { Annotation, DiffStats, Finding, RepoContext } from "@engine/types";
import type { Report, ReportInput } from "@engine/report";

let session: Session | undefined;

/** Live while a repository and a usable Claude CLI are both present. */
/**
 * Findings from a file we did not write in this session.
 *
 * A file can be valid JSON and still not hold findings — half-written, hand
 * edited, or from a version that shaped them differently. Check each one and
 * drop what fails, rather than trusting the extension on the filename.
 */
function usableFindings(input: unknown): Finding[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (f): f is Finding =>
      !!f &&
      typeof f.id === "string" &&
      typeof f.file === "string" &&
      typeof f.title === "string" &&
      Number.isFinite(f.lineStart) &&
      Number.isFinite(f.lineEnd),
  );
}

class Session implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private reviewing = false;
  private currentCommit = "";

  /** What is on screen now, so the next review can say what it resolved. */
  private lastFindings: Finding[] = [];

  /** Where panel state is saved, and which of the rows were reviewer-confirmed. */
  private panelRoot = "";
  private verifiedIds: string[] = [];

  /**
   * The review most recently pushed, kept so ticking a finding can update it.
   *
   * The dashboard scores applied ÷ total over blocking and important findings.
   * A report pushed when the review finishes always reads 0%, because nobody
   * has fixed anything yet — the outcome only exists once the developer has
   * worked through the list, which is minutes or hours later.
   */
  private pushed:
    | { reviewId: string; root: string; findingIds: string[]; input: ReportInput }
    | undefined;

  /** Collapses a burst of ticks into one push. */
  private repushTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * A report the developer asked to hold rather than send.
   *
   * Kept in memory only. Surviving a reload would mean a report sitting on disk
   * that the developer has forgotten deciding about, and the commit it
   * describes is still in history — the next review of that work supersedes it.
   */
  private held:
    | { repoRoot: string; report: Report; shortSha: string; findings: number }
    | undefined;

  /** Supplied by activate(); Session should not know where secrets live. */
  ingestToken: (() => Promise<string | undefined>) | undefined;

  /** Persist which findings the developer has ticked off, and read them back. */
  onProgress: ((commit: string, fixedIds: string[]) => void) | undefined;
  restoreProgress: ((commit: string) => string[]) | undefined;

  constructor(
    readonly repos: RepoContext[],
    readonly claudePath: string,
    readonly cliVersion: string | undefined,
    readonly extensionVersion: string,
    readonly referencesDir: string | null,
    readonly settings: (repoRoot: string) => Settings,
    readonly diagnostics: DiagnosticsView,
    readonly tree: FindingsTree,
    readonly status: StatusBar,
  ) {
    this.disposables.push(diagnostics, tree);
    // One watcher per repository. A window commonly holds several — a frontend
    // and a backend, or a parent folder of services — and watching only the
    // first meant every commit in the others was silently ignored.
    for (const repo of repos) {
      this.disposables.push(
        new CommitWatcher(repo.root, (sha) => {
          void this.reviewCommit(repo.root, sha).catch((err) =>
            log.error("Commit review failed", err),
          );
        }),
      );
    }
  }

  /**
   * Review one commit, show the findings, and report them.
   *
   * Never throws and never blocks. The commit has already happened, so the
   * worst outcome available is a missing review — that must not escalate into
   * a broken editor.
   */
  /**
   * Put a set of findings on screen and hook up progress tracking.
   *
   * Shared by a fresh review and by the restore on startup, so a restored list
   * behaves exactly like a live one — same green ticks, same counts, same
   * squiggles. Two code paths here would mean two behaviours to keep in step.
   */
  private display(
    findings: Finding[],
    repoRoot: string,
    sha: string,
    verifiedIds: string[] = [],
    alreadyFixed: string[] = [],
    persist = true,
  ): void {
    this.currentCommit = sha;
    this.panelRoot = repoRoot;
    this.verifiedIds = verifiedIds;
    this.diagnostics.show(findings, repoRoot);
    this.tree.setFindings(findings, repoRoot);

    // Marking a finding done drops its squiggle too — a green row next to a
    // live warning in the Problems panel is two answers to one question.
    this.tree.onFixedChanged = (id, isFixed) => {
      if (isFixed) {
        this.diagnostics.remove(id);
      } else {
        this.diagnostics.show(
          this.tree.allFindings().filter((f) => !this.tree.isFixed(f.id)),
          repoRoot,
        );
      }
      this.onProgress?.(this.currentCommit, this.tree.fixedIds());
      this.savePanel(this.tree.allFindings(), this.tree.fixedIds());

      // Everything this review raised has been dealt with, so the outcome is
      // final — there is nothing left for the developer to do to it.
      const mine = this.pushed?.findingIds ?? [];
      const done = new Set(this.tree.fixedIds());
      const allDealtWith = mine.length > 0 && mine.every((fid) => done.has(fid));
      this.scheduleRepush(allDealtWith);
    };

    // Green comes from two places: the reviewer confirming a fix on re-read,
    // and the developer ticking a box. Both mean the same thing to the panel.
    const done = [
      ...new Set([...verifiedIds, ...alreadyFixed, ...(this.restoreProgress?.(sha) ?? [])]),
    ];
    if (done.length) {
      this.tree.restoreFixed(done, verifiedIds);
      for (const id of done) this.diagnostics.remove(id);
    }

    // Only what is still outstanding carries into the next review. A finding
    // that has been dealt with is finished: carrying it forward would let a
    // later commit that did not touch its file quietly turn it open again.
    this.lastFindings = findings.filter((f) => !done.includes(f.id));

    if (persist) this.savePanel(findings, done);
  }

  /**
   * What the panel is showing, saved so a reload can show the same thing.
   *
   * Deliberately not last-review.json. That file is the report the dashboard
   * receives, and it must describe one commit — adding findings carried over
   * from earlier commits would inflate the counts a review is judged on. This
   * file is local panel state and nothing else reads it.
   */
  private savePanel(findings: Finding[], fixed: string[]): void {
    if (!this.panelRoot) return;
    try {
      const dir = join(this.panelRoot, ".cr-track");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "panel.json"),
        JSON.stringify(
          {
            version: 1,
            commit: this.currentCommit,
            savedAt: new Date().toISOString(),
            fixed,
            verified: this.verifiedIds,
            findings,
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // Panel state is a convenience. Failing to save it must never affect a
      // review, so there is nothing useful to do here but carry on.
    }
  }

  /**
   * Reload the most recent review from disk on startup.
   *
   * The engine already writes every report to `.cr-track/last-review.json`, so
   * the findings outlive the window; only the panel forgot them. Best-effort by
   * design — a missing, truncated or older-format file just means an empty
   * panel, which is exactly what it was before.
   */
  restoreLastReview(roots: string[]): void {
    // Panel state first: it holds what was actually on screen, including
    // findings carried over from earlier commits and which of them were ticked.
    // last-review.json only ever describes the newest commit, so restoring from
    // it silently drops everything carried forward.
    let panel:
      | { findings: Finding[]; root: string; sha: string; at: string; fixed: string[]; verified: string[] }
      | undefined;

    for (const root of roots) {
      try {
        const doc = JSON.parse(
          readFileSync(join(root, ".cr-track", "panel.json"), "utf8"),
        ) as {
          commit?: string;
          savedAt?: string;
          fixed?: string[];
          verified?: string[];
          findings?: Finding[];
        };
        const findings = usableFindings(doc.findings);
        if (!findings.length || !doc.commit) continue;
        const at = doc.savedAt ?? "";
        if (!panel || at > panel.at) {
          panel = {
            findings,
            root,
            sha: doc.commit,
            at,
            fixed: Array.isArray(doc.fixed) ? doc.fixed : [],
            verified: Array.isArray(doc.verified) ? doc.verified : [],
          };
        }
      } catch {
        // No panel state, or unreadable — fall through to the report below.
      }
    }

    if (panel) {
      try {
        this.display(panel.findings, panel.root, panel.sha, panel.verified, panel.fixed, false);
        const left = this.tree.outstanding().length;
        log.info(
          `Restored ${panel.findings.length} finding(s) from the last session — ${left} still open`,
        );
        return;
      } catch (err) {
        log.warn(`Could not restore panel state: ${String(err)}`);
      }
    }

    let best: { findings: Finding[]; root: string; sha: string; at: string } | undefined;

    for (const root of roots) {
      try {
        const raw = readFileSync(join(root, ".cr-track", "last-review.json"), "utf8");
        const doc = JSON.parse(raw) as {
          findings?: Finding[];
          review?: { commit?: { sha?: string }; completedAt?: string };
        };
        // A file can be valid JSON and still not be a report — half-written,
        // hand-edited, or from a future schema. Check the shape rather than
        // trusting the extension, and drop anything that fails.
        const findings = usableFindings(doc.findings);
        const sha = doc.review?.commit?.sha;
        if (!findings.length || !sha) continue;
        const at = doc.review?.completedAt ?? "";
        // Several repositories can each hold a report; the newest is the one
        // the developer was last looking at.
        if (!best || at > best.at) best = { findings, root, sha, at };
      } catch {
        // No report, unreadable, or not JSON — nothing to restore.
      }
    }

    if (!best) return;
    try {
      this.display(best.findings, best.root, best.sha, [], [], false);
    } catch (err) {
      // Restoring is a convenience. A report we cannot render must never stop
      // the extension starting — the developer would lose reviews entirely,
      // and for a reason nothing on screen would explain.
      log.warn(`Could not restore the last review: ${String(err)}`);
      return;
    }
    const left = this.tree.outstanding().length;
    log.info(
      left
        ? `Restored ${best.findings.length} finding(s) from the last review — ${left} still open`
        : `Restored the last review — all ${best.findings.length} finding(s) marked fixed`,
    );
  }

  /**
   * Review what is staged, before it becomes a commit.
   *
   * Deliberately reports nothing to the dashboard. Nothing has happened yet —
   * the developer is still deciding what to commit — and filing a review for
   * work in progress would count against them twice: once now, and again when
   * the commit that contains it is reviewed for real.
   */
  async reviewStaged(repoRoot: string): Promise<void> {
    if (this.reviewing) {
      log.info("A review is already running — skipping this one");
      void vscode.window.showInformationMessage("CR-Track is already reviewing something.");
      return;
    }
    this.reviewing = true;
    try {
      const context = await readRepoContext(repoRoot);
      const stats = await collectStats(context, "staged");
      const code = stats.files.filter((f) => isReviewableCode(f.path));
      if (!code.length) {
        log.info("Nothing reviewable is staged");
        void vscode.window.showInformationMessage(
          "CR-Track: nothing reviewable is staged. Stage the changes you want checked first.",
        );
        return;
      }

      const diff = await collectDiff(context, "staged");
      if (!diff.trim()) {
        void vscode.window.showInformationMessage("CR-Track: the staged diff is empty.");
        return;
      }

      const cfg = this.settings(repoRoot);
      log.info(
        `Reviewing staged changes — ${code.length} file(s), ` +
          `+${stats.linesAdded}/-${stats.linesRemoved}`,
      );
      this.status.busy("Reviewing staged changes");

      const result = await runReview({
        claudePath: this.claudePath,
        repoRoot,
        diff,
        changedPaths: code.map((f) => f.path),
        config: cfg,
        referencesDir: this.referencesDir,
      });

      if (result.error) {
        log.warn(`Staged review failed: ${result.error}`);
        this.status.failed(result.error);
        void vscode.window.showErrorMessage(`CR-Track: ${result.error}`);
        return;
      }

      // Close the previous commit's review out first. Clearing `pushed` on its
      // own would strand it: scheduleRepush and the next commit's
      // finalizePrevious both return early when there is nothing pushed, so any
      // fixes the developer had ticked for that commit would never be reported
      // and its review would sit unscored for ever.
      this.finalizePrevious();
      this.display(result.findings, repoRoot, `staged-${Date.now()}`, [], [], false);
      this.status.reviewed(result.findings.length, "staged");
      log.info(
        `Staged: ${result.findings.length} finding(s) in ` +
          `${(result.durationMs / 1000).toFixed(0)}s — not reported, this is not a commit`,
      );

      if (result.findings.length) {
        void vscode.commands.executeCommand("crTrack.findings.focus");
        void vscode.window.showWarningMessage(
          `CR-Track found ${result.findings.length} thing(s) in your staged changes. Fix them and commit clean.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          "CR-Track: nothing found in your staged changes.",
        );
      }
    } finally {
      this.reviewing = false;
    }
  }

  async reviewCommit(repoRoot: string, sha: string): Promise<void> {
    if (this.reviewing) {
      log.info("A review is already running — skipping this one");
      return;
    }
    // A new commit closes the previous review: whatever the developer did or
    // did not do about those findings, that is the answer now. Without this a
    // review nobody touched stays unfinalized for ever and is never scored —
    // which is exactly how ignoring every finding becomes invisible.
    this.finalizePrevious();

    this.reviewing = true;
    const triggeredAt = new Date();

    try {
      const commit = await readCommit(repoRoot, sha);
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

      const stats = await commitStats(repoRoot, sha);
      const code = stats.files.filter((f) => isReviewableCode(f.path));
      if (code.length === 0) {
        log.info(`${commit.shortSha} touches no source files — skipping`);
        this.status.idle(`${commit.shortSha}: nothing to review`);
        return;
      }

      // Only now is a held report superseded. Holding meant "let me fix this
      // first", and this commit is that fix — but the skips above are not:
      // discarding on a merge or a docs-only commit would drop the findings
      // with no review taking their place, which is the one outcome the hold
      // was never meant to produce.
      if (this.held) {
        log.info(
          `Discarding the held report for ${this.held.shortSha} — ` +
            `${commit.shortSha} supersedes it`,
        );
        this.held = undefined;
        void vscode.commands.executeCommand("setContext", "crTrack.hasHeld", false);
      }

      const diff = await commitDiff(
        repoRoot,
        sha,
        code.map((f) => f.path),
      );
      if (!diff.trim()) {
        log.info(`${commit.shortSha} produced an empty diff — skipping`);
        return;
      }

      const cfg = this.settings(repoRoot);
      log.info(
        `Reviewing ${commit.shortSha} (${commit.subject}) — ` +
          `${code.length} file(s), +${stats.linesAdded}/-${stats.linesRemoved}`,
      );
      this.status.busy(`Reviewing commit ${commit.shortSha}`);

      const result = await runReview({
        claudePath: this.claudePath,
        repoRoot,
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
      //
      // Findings from the previous commit do not simply vanish. Anything the
      // reviewer re-read and no longer objects to is shown green, so fixing
      // something is visibly finishing it rather than watching it disappear.
      const confirmed = await verifyFixes({
        claudePath: this.claudePath,
        repoRoot,
        diff,
        prior: this.lastFindings.map((f) => ({
          id: f.id,
          file: f.file,
          lineStart: f.lineStart,
          title: f.title,
          description: f.description,
        })),
        model: cfg.model ?? "claude-opus-5",
        timeoutMs: cfg.timeoutMs ?? 600_000,
      });
      const { findings: onScreen, resolvedIds } = reconcile(
        this.lastFindings,
        result.findings,
        confirmed,
      );
      if (resolvedIds.length) {
        log.info(
          `${resolvedIds.length} finding(s) from the previous review are fixed — confirmed on re-read`,
        );
      }
      this.display(onScreen, repoRoot, commit.sha, resolvedIds);
      this.status.reviewed(result.findings.length, commit.shortSha);
      log.info(
        `${commit.shortSha}: ${result.findings.length} finding(s) in ` +
          `${(result.durationMs / 1000).toFixed(0)}s`,
      );
      if (result.findings.length > 0) {
        void vscode.commands.executeCommand("crTrack.findings.focus");
      }

      // Half two: send the outcome to the dashboard.
      await this.report(
        repoRoot,
        commit,
        stats,
        result.findings,
        result.annotations,
        triggeredAt,
        result.durationMs,
        cfg,
      );
    } finally {
      this.reviewing = false;
    }
  }

  /**
   * Re-push the current review with what the developer has actually done.
   *
   * Debounced: working through a list of findings produces a burst of ticks,
   * and each one would otherwise be its own upload. The endpoint is idempotent
   * on review.id, so this overwrites the earlier push in place rather than
   * filing a second review.
   */
  private scheduleRepush(finalized = false): void {
    if (!this.pushed) return;
    if (this.repushTimer) clearTimeout(this.repushTimer);
    this.repushTimer = setTimeout(() => {
      void this.repush(finalized).catch((err) =>
        log.warn(`Could not update the review on the dashboard: ${String(err)}`),
      );
    }, finalized ? 0 : 3_000);
  }

  /**
   * Send the outcome of a review that has already been pushed once.
   *
   * `finalized` says the developer is done — sent when every finding has been
   * dealt with, and when the next commit closes this review out. Until then the
   * dashboard gets live counts but is told not to score them yet, because a
   * developer half-way through a list is not a developer who fixed half of it.
   */
  private async repush(finalized: boolean): Promise<void> {
    const pushed = this.pushed;
    if (!pushed) return;

    const endpoint = readEndpoint(pushed.root);
    if (!endpoint) return;

    // Only findings from the review being updated. The panel also shows ones
    // carried over from earlier commits, and those belong to their own reports.
    const fixed = new Set(this.tree.fixedIds().filter((id) => pushed.findingIds.includes(id)));
    const outcomes = new Map<string, { status: "applied" }>();
    for (const id of fixed) outcomes.set(id, { status: "applied" });

    const { report } = buildReport({
      ...pushed.input,
      reviewId: pushed.reviewId,
      outcomes,
      finalized,
    });

    const token = await this.ingestToken?.();
    const result = await deliver(pushed.root, report, {
      endpoint,
      ...(token ? { token } : {}),
    });

    if (result.permanentFailure) {
      reportRejection(result, endpoint);
      return;
    }
    log.info(
      `Updated review ${pushed.reviewId.slice(0, 8)} on the dashboard — ` +
        `${fixed.size}/${pushed.findingIds.length} fixed${finalized ? ", finalized" : ""}` +
        `${result.uploaded ? "" : " (queued)"}`,
    );
  }

  /** Close out the previous review: the developer has moved on to a new commit. */
  private finalizePrevious(): void {
    if (!this.pushed) return;
    if (this.repushTimer) clearTimeout(this.repushTimer);
    void this.repush(true).catch((err) =>
      log.warn(`Could not finalize the previous review: ${String(err)}`),
    );
    this.pushed = undefined;
  }

  /**
   * Ask the developer whether this review should be recorded.
   *
   * A report cannot be withdrawn once filed, and the counts in it become part
   * of how their work is measured — so the choice to send belongs to them.
   * Answering "wait" holds the report rather than discarding it: a held report
   * that quietly disappeared would be indistinguishable from one that failed to
   * send, and the developer would have no way to change their mind.
   *
   * A clean review is sent without asking. There is nothing to fix and nothing
   * to reconsider, and a dialog on every clean commit is how a prompt stops
   * being read.
   */
  private async confirmSend(
    repoRoot: string,
    commit: CommitInfo,
    report: Report,
    findings: Finding[],
  ): Promise<boolean> {
    if (!this.settings(repoRoot).confirmBeforeSending) return true;
    if (!findings.length) return true;

    const counts = new Map<string, number>();
    for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    const summary = ["blocking", "important", "nit", "suggestion"]
      .filter((sev) => counts.has(sev))
      .map((sev) => `${counts.get(sev)} ${sev}`)
      .join(", ");

    const choice = await vscode.window.showWarningMessage(
      `CR-Track found ${findings.length} finding(s) in ${commit.shortSha} — ${summary}.`,
      { modal: false, detail: "Sending records them against you on the dashboard." },
      "Send to dashboard",
      "Wait — I'll fix first",
      "Show findings",
    );

    if (choice === "Show findings") {
      await vscode.commands.executeCommand("crTrack.findings.focus");
      // Asked again rather than decided by a detour: opening the panel is not
      // an answer to the question.
      return this.confirmSend(repoRoot, commit, report, findings);
    }

    if (choice === "Send to dashboard") {
      this.held = undefined;
      return true;
    }

    // "Wait", or dismissed. Dismissing is not consent to send.
    this.held = { repoRoot, report, shortSha: commit.shortSha, findings: findings.length };
    this.status.held(commit.shortSha, findings.length);
    log.info(
      `${commit.shortSha}: holding the report at the developer's request — ` +
        `${findings.length} finding(s) not sent`,
    );
    void vscode.window.showInformationMessage(
      `Holding ${commit.shortSha}. Fix and commit again, or send it from the Findings panel.`,
    );
    return false;
  }

  /** Send a report the developer previously chose to hold. */
  async sendHeld(): Promise<void> {
    const held = this.held;
    if (!held) {
      void vscode.window.showInformationMessage("CR-Track: nothing is being held.");
      return;
    }
    const endpoint = readEndpoint(held.repoRoot);
    if (!endpoint) return;
    const token = await this.ingestToken?.();
    const result = await deliver(held.repoRoot, held.report, {
      endpoint,
      ...(token ? { token } : {}),
    });
    if (result.permanentFailure) {
      reportRejection(result, endpoint);
      return;
    }
    this.held = undefined;
    void vscode.commands.executeCommand("setContext", "crTrack.hasHeld", false);
    log.info(`Sent the held report for ${held.shortSha} (${result.status ?? "queued"})`);
    void vscode.window.showInformationMessage(`CR-Track: sent ${held.shortSha} to the dashboard.`);
  }

  /** Whether a report is waiting on the developer. */
  heldSummary(): { shortSha: string; findings: number } | undefined {
    return this.held ? { shortSha: this.held.shortSha, findings: this.held.findings } : undefined;
  }

  private async report(
    repoRoot: string,
    commit: CommitInfo,
    stats: DiffStats,
    findings: Finding[],
    annotations: Annotation[],
    triggeredAt: Date,
    durationMs: number,
    cfg: Settings,
  ): Promise<void> {
    try {
      // Read fresh rather than reusing what activation saw: the branch, the
      // dirty flag and even the remote can all have changed since.
      const context = await readRepoContext(repoRoot);
      const reportInput: ReportInput = {
        repo: { ...context, head: commit.sha, headShort: commit.shortSha },
        stats,
        findings,
        // The reviewer returns learning and praise notes alongside findings.
        // These were being dropped here, so a prompt that produced them would
        // still have shown nothing: the report never carried them.
        annotations,
        outcomes: new Map(),
        scope: "committed",
        model: cfg.model,
        effort: cfg.effort,
        durationMs,
        triggeredAt,
        completedAt: new Date(),
        extensionVersion: this.extensionVersion,
        ...(this.cliVersion ? { cliVersion: this.cliVersion } : {}),
      };
      const { report, redactionHits } = buildReport(reportInput);

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

      const endpoint = readEndpoint(repoRoot);

      // Ask before recording anything against the developer. They may want to
      // fix what was found and recommit, and a report already filed cannot be
      // withdrawn.
      //
      // The local copy is written either way. It is the durable record and it
      // never leaves the machine; withholding it because the developer declined
      // to publish would lose the review entirely, including from the panel
      // after a reload.
      if (endpoint && !(await this.confirmSend(repoRoot, commit, report, findings))) {
        await deliver(repoRoot, report, {});
        return;
      }

      const token = await this.ingestToken?.();
      const result = await deliver(repoRoot, report, {
        ...(endpoint ? { endpoint } : {}),
        ...(token ? { token } : {}),
      });

      if (result.permanentFailure) {
        reportRejection(result, endpoint);
        return;
      }

      // Remember this review so ticking a finding can update it in place. The
      // ids come from the report, not the panel: the panel also shows findings
      // carried over from earlier commits, which belong to other reports.
      this.pushed = {
        // The report types these as loose records, so narrow them here rather
        // than trusting the shape at the point of use.
        reviewId: String(report.review["id"] ?? ""),
        root: repoRoot,
        findingIds: report.findings
          .map((f) => f["id"])
          .filter((id): id is string => typeof id === "string"),
        input: reportInput,
      };

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
    // A tick within the debounce window would otherwise fire after the window
    // has gone, pushing a report for a review the developer has already left.
    if (this.repushTimer) {
      clearTimeout(this.repushTimer);
      this.repushTimer = undefined;
    }
    for (const d of this.disposables) d.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────

/** Where the ingest token lives. */
const TOKEN_KEY = "crTrack.ingestToken";

/**
 * The developer's ingest token.
 *
 * Kept in VS Code's SecretStorage, not settings: a settings entry is written to
 * settings.json, which gets committed, shared and synced between machines, and
 * these tokens identify one person. The environment variable is kept as a
 * fallback so CI and headless runs still have a way in.
 */
async function readToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(TOKEN_KEY);
  if (stored?.trim()) return stored.trim();
  const fromEnv = process.env["CR_TRACK_INGEST_TOKEN"]?.trim();
  return fromEnv || undefined;
}

/**
 * Tell the developer about a rejection retrying cannot fix.
 *
 * These are the two cases where silence is worst: the report is not queued, so
 * nothing will ever pick it up again, and the cause is something only a person
 * can put right. The log always gets the full detail; the notification is
 * offered once, because a wrong token means every commit hits this.
 */
function reportRejection(
  result: { permanentFailure?: "auth" | "payload"; status?: number; detail?: string; details?: string[] },
  endpoint: string | undefined,
): void {
  if (result.permanentFailure === "auth") {
    log.warn(
      `The dashboard rejected the report: ${result.status} unauthorized. ` +
        `The ingest token is missing, wrong or revoked (endpoint ${endpoint ?? "unset"}).`,
    );
    if (warnedAboutToken) return;
    warnedAboutToken = true;
    void vscode.window
      .showWarningMessage(
        "CR-Track: the dashboard rejected your ingest token. Reviews still run and are saved locally, but nothing is being recorded.",
        "Set token",
        "Show log",
      )
      .then((choice) => {
        if (choice === "Set token") void vscode.commands.executeCommand("crTrack.setIngestToken");
        else if (choice === "Show log") log.show();
      });
    return;
  }

  // A malformed payload is our bug, not the developer's. Put every reason the
  // server gave in the log — that list is the whole diagnostic.
  log.warn(`The dashboard rejected the report as invalid (${result.status}).`);
  for (const d of result.details ?? []) log.warn(`  - ${d}`);
  if (!result.details?.length && result.detail) log.warn(`  ${result.detail}`);
}

/** One notification per window, not one per commit. */
let warnedAboutToken = false;

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

/**
 * Every git repository this window can see.
 *
 * Three sources, because none alone is sufficient. Workspace folders cover the
 * ordinary case. VS Code's own Git extension is authoritative for anything it
 * has already found — including repositories nested inside a folder that is not
 * one itself, which is exactly the layout that made CR-Track report "not a git
 * repo" beside a Source Control panel listing two of them. A one-level scan
 * catches a parent folder of checkouts when the Git extension is disabled.
 */
async function discoverRepos(): Promise<{ roots: string[]; blocked?: RepoCheckFailure }> {
  const roots = new Set<string>();
  let firstFailure: RepoCheckFailure | undefined;

  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const check = await checkRepo(folder.uri.fsPath);
    if (check.ok) {
      const root = await repoRootOf(folder.uri.fsPath);
      if (root) roots.add(root);
    } else if (!firstFailure) {
      firstFailure = { path: folder.uri.fsPath, reason: check.reason, detail: check.detail };
    }
  }

  for (const root of gitExtensionRepos()) roots.add(root);

  // Only worth scanning when nothing else found anything — it costs a stat per
  // child directory, and a large parent folder would make that noticeable.
  if (roots.size === 0) {
    for (const folder of folders) {
      for (const child of childRepos(folder.uri.fsPath)) {
        const root = await repoRootOf(child);
        if (root) roots.add(root);
      }
    }
  }

  const out = [...roots].sort();
  return firstFailure && out.length === 0 ? { roots: out, blocked: firstFailure } : { roots: out };
}

interface RepoCheckFailure {
  path: string;
  reason: string;
  detail: string;
}

/** Resolve any path inside a repository to its top level. */
async function repoRootOf(cwd: string): Promise<string | null> {
  try {
    const ctx = await readRepoContext(cwd);
    return ctx.root || null;
  } catch {
    return null;
  }
}

/**
 * Repositories the built-in Git extension already knows about.
 *
 * Deliberately defensive: this reaches into another extension's API, and a
 * shape change there must degrade to "found none" rather than break activation.
 */
function gitExtensionRepos(): string[] {
  try {
    const ext = vscode.extensions.getExtension("vscode.git");
    const api = ext?.isActive ? ext.exports?.getAPI?.(1) : undefined;
    const repos: unknown[] = api?.repositories ?? [];
    return repos
      .map((r) => (r as { rootUri?: { fsPath?: string } })?.rootUri?.fsPath)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

/** Immediate subdirectories that contain a `.git`. */
function childRepos(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(parent, e.name))
      .filter((dir) => existsSync(join(dir, ".git")));
  } catch {
    return [];
  }
}

/**
 * Whether the developer wants CR-Track working in a given repository.
 *
 * Kept per repository path in global state rather than in workspace state or a
 * setting. Global state because the answer belongs to the person, not to the
 * window: reopening the same folder should not ask again, and opening it in a
 * second window should not ask a second time. Not a setting, because a setting
 * written into .vscode/settings.json is committed and would silently switch the
 * tool off for everyone else on the team.
 */
const REPO_CHOICES = "crTrack.repoChoices";

type RepoChoice = "on" | "off";

function repoChoices(context: vscode.ExtensionContext): Record<string, RepoChoice> {
  return context.globalState.get<Record<string, RepoChoice>>(REPO_CHOICES) ?? {};
}

function repoChoice(context: vscode.ExtensionContext, root: string): RepoChoice | undefined {
  return repoChoices(context)[normalizeRoot(root)];
}

async function setRepoChoice(
  context: vscode.ExtensionContext,
  root: string,
  choice: RepoChoice | undefined,
): Promise<void> {
  const all = { ...repoChoices(context) };
  if (choice) all[normalizeRoot(root)] = choice;
  else delete all[normalizeRoot(root)];
  await context.globalState.update(REPO_CHOICES, all);
}

/**
 * One spelling per repository.
 *
 * The same folder arrives spelled differently depending on where it came from:
 * the workspace folder gives Windows' 8.3 short form (DEVELO~1) while git gives
 * the long one, and case and trailing slashes vary on top of that. Storing the
 * choice under whichever spelling happened to be in hand meant a developer
 * could turn CR-Track off and have the button fail to turn it back on, because
 * it was reading a key nothing had ever written.
 *
 * realpath resolves the short form; it also follows symlinks, which is the same
 * problem in a different costume.
 */
function normalizeRoot(root: string): string {
  let resolved = root;
  try {
    resolved = realpathSync.native(root);
  } catch {
    // The path may not exist yet, or be on a filesystem that cannot answer.
    // Falling back to the literal is worse than resolving, but better than
    // throwing out of a lookup.
  }
  return resolved
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/**
 * Ask, once, whether this repository should be reviewed.
 *
 * Only asked when there is no answer on record. Asking on every activation
 * would be a dialog on every window open, which is how a tool gets uninstalled.
 */
async function askAboutRepo(
  context: vscode.ExtensionContext,
  root: string,
  name: string,
): Promise<RepoChoice> {
  const known = repoChoice(context, root);
  if (known) return known;

  const answer = await vscode.window.showInformationMessage(
    `Review commits in ${name} with CR-Track?`,
    { modal: false },
    "Yes, review this repo",
    "Not this one",
  );
  // Dismissed rather than answered: treat as yes for now but record nothing, so
  // the question is asked again next time instead of being decided by a stray
  // click on the notification's close button.
  if (!answer) return "on";

  const choice: RepoChoice = answer === "Yes, review this repo" ? "on" : "off";
  await setRepoChoice(context, root, choice);
  log.info(`${name}: ${choice === "on" ? "enabled" : "disabled"} by the developer`);
  return choice;
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

  let found = await discoverRepos();

  // Ownership refusal is worth one prompt: on a shared or copied checkout git
  // simply refuses, and the message it gives is not one most people recognise.
  if (found.roots.length === 0 && found.blocked && isDubiousOwnership(found.blocked.detail)) {
    const choice = await vscode.window.showWarningMessage(
      `CR-Track: git will not open ${found.blocked.path} — it is owned by another user account.`,
      "Trust this folder",
    );
    if (choice === "Trust this folder" && (await trustDirectory(found.blocked.path))) {
      found = await discoverRepos();
    }
  }

  if (found.roots.length === 0) {
    const summary =
      found.blocked && found.blocked.reason !== "not-a-repo"
        ? "git could not be used"
        : "no git repository here";
    // Log a reason once per distinct cause; repeating it on every recheck
    // buries everything else and reads like a fault in itself.
    const fingerprint = `${cwd}|${summary}`;
    if (lastDormant !== fingerprint) {
      lastDormant = fingerprint;
      log.warn(`${cwd}: ${summary}`);
      log.info(`  git = ${gitPath()}`);
      if (found.blocked) log.info(`  ${found.blocked.detail}`);
      log.info(`  searched ${(vscode.workspace.workspaceFolders ?? []).length} workspace folder(s)`);
    }
    status.dormant(summary);
    armRecovery(context, status, cwd);
    return;
  }

  const repos: RepoContext[] = [];
  for (const root of found.roots) {
    try {
      repos.push(await readRepoContext(root));
    } catch (err) {
      log.warn(`Skipping ${root}: ${(err as Error).message}`);
    }
  }
  if (repos.length === 0) {
    status.dormant("git could not be used");
    armRecovery(context, status, cwd);
    return;
  }

  // Configuration is per repository — a `.cr-track.yaml` belongs to its own
  // project, not to whichever one happened to be listed first.
  const settings = (repoRoot: string): Settings => readSettings(repoRoot);
  const primary = repos[0]!;

  if (!settings(primary.root).enabled) {
    log.info("Disabled via crTrack.enabled");
    status.dormant("disabled in settings");
    disarmRecovery();
    return;
  }

  // Asked once per repository, then remembered. A developer opening a client's
  // repository, or a scratch clone, should not have its commits reviewed and
  // recorded against them just because the extension is installed.
  if ((await askAboutRepo(context, primary.root, primary.name)) === "off") {
    log.info(`${primary.name}: off for this repository`);
    status.dormant(`off in ${primary.name}`);
    disarmRecovery();
    return;
  }

  const gate = await checkStartup(context, settings(primary.root).claudePath);
  if (!gate.ready || !gate.claudePath) {
    status.dormant(gate.reason ?? "the Claude CLI is unavailable");
    armRecovery(context, status, cwd);
    return;
  }

  const referencesDir = findReferencesDir(context.extensionUri.fsPath);
  if (referencesDir) log.info(`Guides: ${referencesDir}`);
  else log.warn("Guides not found — findings will be weaker than they should be");

  session = new Session(
    repos,
    gate.claudePath,
    gate.version,
    context.extension?.packageJSON?.version ?? "0.0.0",
    referencesDir,
    settings,
    new DiagnosticsView(),
    new FindingsTree(),
    status,
  );

  // Progress survives a reload: someone half-way through a list of findings
  // should not lose their place because the window restarted.
  const PROGRESS_KEY = "crTrack.fixed";
  session.restoreProgress = (commit) => {
    const all = context.workspaceState.get<Record<string, string[]>>(PROGRESS_KEY) ?? {};
    return all[commit] ?? [];
  };
  session.onProgress = (commit, ids) => {
    const all = context.workspaceState.get<Record<string, string[]>>(PROGRESS_KEY) ?? {};
    // Re-inserting moves this commit to the end, so the map stays in
    // least-recently-touched order. Without the delete, updating an existing
    // commit leaves it at its original position and the pruning below can
    // discard the very entry just written.
    delete all[commit];
    all[commit] = ids;

    // Keep only the most recent handful; this is a convenience, not a record,
    // and an unbounded map in workspace state is a slow leak.
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
    void context.workspaceState.update(PROGRESS_KEY, all);
  };

  // Bring the last review back on screen. Without this the panel is empty
  // after every window reload until the next commit, so a half-finished list
  // of findings — and the progress through it — silently disappears.
  session.ingestToken = () => readToken(context);
  session.restoreLastReview(repos.map((r) => r.root));

  disarmRecovery();
  lastDormant = undefined;
  const names = repos.map((r) => r.name).join(", ");
  status.idle(
    repos.length === 1
      ? `watching ${primary.name} for commits`
      : `watching ${repos.length} repositories for commits`,
  );
  log.info(`Active on ${names} — every new commit will be reviewed`);
  for (const r of repos) log.info(`  ${r.name} (${r.branch}) — ${r.root}`);

  const token = await readToken(context);
  for (const r of repos) {
    const endpoint = readEndpoint(r.root);
    if (!endpoint) continue;
    void flushQueue(r.root, { endpoint, ...(token ? { token } : {}) })
      .then(({ sent, remaining }) => {
        if (sent || remaining) log.info(`Report queue: sent ${sent}, ${remaining} remaining`);
      })
      .catch((err) => log.error("Queue flush failed", err));
  }
  if (!repos.some((r) => readEndpoint(r.root))) {
    log.info("No dashboard endpoint configured — reports stay in .cr-track/");
  }
}

/** The git binary the user has already told the editor about, if any. */
function gitOverrideSetting(): string | string[] | undefined {
  const own = vscode.workspace.getConfiguration("crTrack").get<string>("gitPath")?.trim();
  if (own) return own;
  return vscode.workspace.getConfiguration("git").get<string | string[] | null>("path") ?? undefined;
}

/** The open repository containing the file the developer is currently editing. */
function repoForActiveEditor(repos: RepoContext[]): RepoContext | undefined {
  const file = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!file) return undefined;
  const normalized = file.split("\\").join("/").toLowerCase();
  // Longest root first, so a repository nested inside another still wins.
  return [...repos]
    .sort((a, b) => b.root.length - a.root.length)
    .find((r) => normalized.startsWith(r.root.split("\\").join("/").toLowerCase()));
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
    // With several repositories open, the one the developer is looking at is
    // the one they mean. Falling back to "the first" would review a different
    // project's commit without saying so.
    const target = repoForActiveEditor(active.repos) ?? active.repos[0]!;
    // Read HEAD now rather than trusting the value captured at activation —
    // by definition the developer has committed since then.
    const sha = (await headSha(target.root)) || target.head;
    if (!sha) {
      void vscode.window.showInformationMessage(
        `CR-Track: ${target.name} has no commits yet.`,
      );
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CR-Track: reviewing the last commit in ${target.name}`,
      },
      () => active.reviewCommit(target.root, sha),
    );
  });

  register("crTrack.showOutput", () => log.show());

  register("crTrack.retryDetection", async () => {
    // Everything cached is thrown away, not just the CLI result: someone
    // running this has already concluded the extension is wrong about their
    // machine, and a half-cleared cache would leave them still right.
    clearStartupCache();
    lastDormant = undefined;
    log.show();
    log.info("──────── re-detecting ────────");
    await start(context, status);
    if (session) {
      void vscode.window.showInformationMessage(
        `CR-Track is active on ${session.repos.map((r) => r.name).join(", ")}.`,
      );
    } else {
      const choice = await vscode.window.showWarningMessage(
        "CR-Track is still inactive. The log lists every path that was tried.",
        "Show log",
        "Set Claude path…",
      );
      if (choice === "Show log") log.show();
      else if (choice === "Set Claude path…") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "crTrack.claudePath");
      }
    }
  });

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

    const folders = vscode.workspace.workspaceFolders ?? [];
    log.info(`folders    : ${folders.length}`);
    for (const f of folders) {
      const check = await checkRepo(f.uri.fsPath);
      log.info(`  ${check.ok ? "repo" : "----"}  ${f.uri.fsPath}${check.ok ? "" : ` (${check.detail})`}`);
    }
    const fromGitExt = gitExtensionRepos();
    log.info(`git ext    : ${fromGitExt.length ? fromGitExt.join(", ") : "(none / not active)"}`);
    const discovered = await discoverRepos();
    log.info(
      `repositories: ${discovered.roots.length ? discovered.roots.join(", ") : "NONE FOUND"}`,
    );
    log.info(`watching   : ${session ? session.repos.map((r) => r.name).join(", ") : "(inactive)"}`);
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

  /**
   * One finding, formatted to be pasted straight into an assistant.
   *
   * File and line first because that is what a reader needs to locate it, and
   * the suggestion last because that is the part being acted on. Plain text,
   * no markdown fences — it goes into a chat box as often as into a file.
   */
  function findingAsText(f: Finding): string {
    const lines = f.lineStart === f.lineEnd ? `${f.lineStart}` : `${f.lineStart}-${f.lineEnd}`;
    return [
      `${f.file}:${lines}  [${f.severity} · ${f.category}]`,
      f.title,
      "",
      f.description,
      "",
      `Suggested: ${f.suggestion}`,
    ].join("\n");
  }

  const findingOf = (arg: unknown): Finding | undefined => {
    const node = arg as { kind?: string; finding?: Finding } | undefined;
    return node?.kind === "finding" ? node.finding : undefined;
  };

  register("crTrack.sendHeld", async () => {
    if (!session) {
      void vscode.window.showInformationMessage("CR-Track: nothing is being held.");
      return;
    }
    await session.sendHeld();
    await vscode.commands.executeCommand("setContext", "crTrack.hasHeld", !!session.heldSummary());
  });

  register("crTrack.toggleRepo", async () => {
    const root =
      session?.tree.currentRepoRoot() ||
      session?.repos[0]?.root ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showWarningMessage("CR-Track: no folder is open.");
      return;
    }
    const name = root.split(/[\/]/).filter(Boolean).pop() ?? root;
    const now = repoChoice(context, root) ?? "on";

    if (now === "on") {
      await setRepoChoice(context, root, "off");
      log.info(`${name}: turned off for this repository`);
      // Stop immediately rather than at the next window: the developer turned
      // it off because they do not want the next commit reviewed.
      session?.dispose();
      session = undefined;
      status.dormant(`off in ${name}`);
      void vscode.window.showInformationMessage(
        `CR-Track is off in ${name}. Commits here will not be reviewed or recorded.`,
      );
      return;
    }

    await setRepoChoice(context, root, "on");
    log.info(`${name}: turned on for this repository`);
    await start(context, status);
    void vscode.window.showInformationMessage(`CR-Track is on in ${name}.`);
  });

  register("crTrack.reviewStaged", async () => {
    if (!session) await start(context, status);
    if (!session) {
      const choice = await vscode.window.showWarningMessage(
        "CR-Track is inactive here.",
        "Diagnose",
      );
      if (choice === "Diagnose") await vscode.commands.executeCommand("crTrack.diagnose");
      return;
    }
    const root = session.tree.currentRepoRoot() || session.repos[0]?.root;
    if (!root) return;
    await session.reviewStaged(root);
  });

  register("crTrack.update", async () => {
    // The host reports are sent to and the host the extension is downloaded
    // from are different things, and a team serving the extension themselves
    // needs this pointed at their origin — otherwise the button would fetch a
    // build they did not publish.
    const host = (vscode.workspace.getConfiguration("crTrack").get<string>("updateHost") ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!host) {
      void vscode.window.showWarningMessage(
        "CR-Track: no update host is configured (crTrack.updateHost).",
      );
      return;
    }

    const current = String(context.extension?.packageJSON?.version ?? "0.0.0");

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "CR-Track: checking for an update…" },
      async () => {
        let latest: string;
        try {
          const res = await fetch(`${host}/version.txt`);
          if (!res.ok) throw new Error(`the server answered ${res.status}`);
          latest = (await res.text()).trim();
        } catch (err) {
          log.warn(`Update check failed against ${host}: ${String(err)}`);
          void vscode.window.showErrorMessage(
            `CR-Track: could not reach ${host} to check for an update.`,
          );
          return;
        }

        if (!latest) {
          void vscode.window.showErrorMessage("CR-Track: the update host returned no version.");
          return;
        }
        if (latest === current) {
          void vscode.window.showInformationMessage(`CR-Track is up to date (${current}).`);
          return;
        }

        // Download to a temp file. VS Code installs from a file, not a URL.
        const dir = mkdtempSync(join(tmpdir(), "cr-track-update-"));
        const vsix = join(dir, `cr-track-${latest}.vsix`);
        try {
          const res = await fetch(`${host}/cr-track-latest.vsix`);
          if (!res.ok) throw new Error(`the download answered ${res.status}`);
          const bytes = Buffer.from(await res.arrayBuffer());

          // A .vsix is a zip. Anything else means a proxy or an error page came
          // back with a 200, and handing that to VS Code fails several steps
          // later with a message that explains nothing.
          if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            throw new Error("what came back is not a .vsix");
          }
          writeFileSync(vsix, bytes);

          await vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            vscode.Uri.file(vsix),
          );
        } catch (err) {
          log.warn(`Update to ${latest} failed: ${String(err)}`);
          void vscode.window.showErrorMessage(
            `CR-Track: update to ${latest} failed — ${String(err)}. The installer command still works.`,
          );
          return;
        } finally {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* a temp directory we could not remove is not worth reporting */
          }
        }

        log.info(`Updated from ${current} to ${latest}.`);
        // The new build is on disk but the old one is still the code running.
        // Saying "updated" without saying that invites someone to conclude the
        // update did nothing when the panel behaves exactly as before.
        const choice = await vscode.window.showInformationMessage(
          `CR-Track updated to ${latest}. Reload the window to start using it.`,
          "Reload window",
        );
        if (choice === "Reload window") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      },
    );
  });

  register("crTrack.setIngestToken", async () => {
    const existing = await context.secrets.get(TOKEN_KEY);
    const entered = await vscode.window.showInputBox({
      title: "CR-Track ingest token",
      prompt: "Your personal token from the dashboard admin. Stored in VS Code's secret storage, never in settings.",
      placeHolder: existing ? "A token is already stored — type a new one to replace it" : "Paste your token",
      password: true,
      ignoreFocusOut: true,
    });
    // Cancelled. Leave whatever was there alone; clearing a working token
    // because someone pressed Escape would be its own bug.
    if (entered === undefined) return;

    const value = entered.trim();
    if (!value) {
      await context.secrets.delete(TOKEN_KEY);
      log.info("Ingest token cleared.");
      void vscode.window.showInformationMessage("CR-Track: ingest token cleared.");
      return;
    }

    await context.secrets.store(TOKEN_KEY, value);
    warnedAboutToken = false;
    log.info("Ingest token stored.");

    // Say now whether it works, rather than at the next commit. A token that
    // was mistyped, revoked, or minted for somewhere else is indistinguishable
    // from a working one until something is sent, and the first person to find
    // out is usually the one wondering why the dashboard is empty.
    const endpoint = readEndpoint(
      session?.repos[0]?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    );
    if (!endpoint) {
      void vscode.window.showInformationMessage(
        "CR-Track: token saved. No dashboard is configured, so reports stay on disk.",
      );
      return;
    }

    const verdict = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "CR-Track: checking your token…" },
      () => checkToken(endpoint, value),
    );

    if (verdict === "ok") {
      log.info(`Ingest token accepted by ${endpoint}.`);
      void vscode.window.showInformationMessage(
        "CR-Track: token accepted. Your next commit will be recorded.",
      );
      return;
    }
    if (verdict === "unauthorized") {
      log.warn(`The dashboard rejected the token (${endpoint}).`);
      void vscode.window.showErrorMessage(
        "CR-Track: the dashboard rejected that token. Check it was copied whole, and that it has not been revoked.",
      );
      return;
    }
    log.warn(`Could not reach ${endpoint} to check the token.`);
    void vscode.window.showWarningMessage(
      "CR-Track: token saved, but the dashboard could not be reached to check it. It will be used anyway.",
    );
  });

  register("crTrack.copyFinding", async (arg: unknown) => {
    const f = findingOf(arg);
    if (!f) return;
    await vscode.env.clipboard.writeText(findingAsText(f));
    void vscode.window.setStatusBarMessage("$(check) Finding copied", 2000);
  });

  register("crTrack.copyAllFindings", async () => {
    const open = session?.tree.outstanding() ?? [];
    if (!open.length) {
      void vscode.window.showInformationMessage("CR-Track: nothing left to copy.");
      return;
    }
    const text = open.map(findingAsText).join("\n\n---\n\n");
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage(
      `$(check) Copied ${open.length} finding(s)`,
      2500,
    );
  });

  register("crTrack.markFixed", (arg: unknown) => {
    const f = findingOf(arg);
    if (!f || !session) return;
    session.tree.markFixed(f.id, true);
  });

  register("crTrack.markNotFixed", (arg: unknown) => {
    const f = findingOf(arg);
    if (!f || !session) return;
    session.tree.markFixed(f.id, false);
  });

  register("crTrack.revealFinding", async (arg: unknown) => {
    const finding = findingOf(arg);
    if (!finding || !session) return;
    try {
      const root = session.tree.currentRepoRoot() || session.repos[0]?.root || "";
      const uri = vscode.Uri.joinPath(vscode.Uri.file(root), finding.file);
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
