/**
 * Detects a commit landing, which is the extension's only trigger.
 *
 * `.git/logs/HEAD` — the reflog — gains a line for every operation that moves
 * HEAD, and unlike `.git/refs/heads/<branch>` it is a single known path that
 * exists whether or not refs are packed. Watching it is therefore the one
 * reliable signal that something happened.
 *
 * HEAD also moves for checkouts, resets and rebases. Reviewing after a branch
 * switch would hand the model an enormous unrelated diff, so the reflog's
 * action word decides whether a move was actually a commit.
 */

import { join } from "node:path";
import * as vscode from "vscode";
import { checkRepo, commitTimestamp, headSha, lastRefAction } from "@engine/git";
import { log } from "./log";

/** Reflog actions that mean "the developer committed something". */
const COMMIT_ACTIONS = new Set(["commit", "commit (amend)", "commit (initial)", "commit (merge)"]);

/**
 * How old a commit may be and still count as "just landed".
 *
 * A commit CR-Track is meant to review was made seconds ago, by definition —
 * the watcher fired because it appeared. Anything older is history that was
 * already there, and reviewing it makes the extension look like it fires at
 * random. Generous enough to survive a slow machine and a skewed clock.
 */
const FRESH_MS = 10 * 60 * 1000;

export class CommitWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastSeen = "";
  private disposed = false;
  /**
   * Resolves once the starting HEAD is recorded. A commit made in the first
   * moments after activation would otherwise race the priming read and be
   * compared against an empty `lastSeen`, which reviews whatever was already
   * there.
   */
  private readonly primed: Promise<void>;
  /**
   * Whether the starting HEAD is actually known.
   *
   * An empty `lastSeen` has two very different causes. A repository with no
   * commits yet is fine — its first commit really is new and must be reviewed.
   * Git failing to answer is not: assuming the current HEAD is new reviews
   * whatever history happens to be sitting there, which is how a week-old
   * commit ended up being reviewed on a machine in the wild.
   */
  private primeOk = false;

  constructor(
    private readonly repoRoot: string,
    private readonly onCommit: (sha: string) => void,
  ) {
    this.primed = this.prime();

    // Both files move on a commit; watching each covers packed and unpacked
    // repositories and the rare case of a reflog being disabled.
    for (const rel of ["logs/HEAD", "HEAD"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(join(repoRoot, ".git")), rel),
      );
      watcher.onDidChange(() => this.schedule());
      watcher.onDidCreate(() => this.schedule());
      this.disposables.push(watcher);
    }
    log.info(`Watching for commits in ${repoRoot}`);
  }

  /** Record the current HEAD so an existing commit is not reviewed on startup. */
  private async prime(): Promise<void> {
    this.lastSeen = await headSha(this.repoRoot);
    if (this.lastSeen) {
      this.primeOk = true;
      return;
    }
    // No HEAD. Ask git whether that is because the repository is empty.
    this.primeOk = (await checkRepo(this.repoRoot)).ok;
    log.info(
      this.primeOk
        ? "No commits yet — the first one will be reviewed"
        : "Could not read HEAD at startup; the current commit will be adopted, not reviewed",
    );
  }

  /**
   * Git writes several files while committing, so the watcher fires more than
   * once per commit. Debouncing collapses that into one review.
   */
  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check().catch((err) => log.error("Commit check failed", err));
    }, 1_200);
  }

  private async check(): Promise<void> {
    await this.primed;
    if (this.disposed) return;

    const sha = await headSha(this.repoRoot);
    if (!sha) return;

    // Priming failed outright, so the current HEAD tells us nothing about what
    // is new. Adopt it and wait for the next move.
    if (!this.primeOk) {
      this.lastSeen = sha;
      this.primeOk = true;
      log.info(`Adopted ${sha.slice(0, 8)} as the starting point`);
      return;
    }
    if (sha === this.lastSeen) return;

    const action = await lastRefAction(this.repoRoot);
    this.lastSeen = sha;

    if (!COMMIT_ACTIONS.has(action)) {
      log.info(`HEAD moved to ${sha.slice(0, 8)} via "${action}" — not a commit, ignoring`);
      return;
    }

    // Belt and braces. The reflog says a commit put HEAD here, but a reflog can
    // be replayed and a clone rewrites one wholesale; the commit's own date is
    // the independent check that this actually just happened.
    const madeAt = await commitTimestamp(this.repoRoot, sha);
    const ageMs = Date.now() - madeAt * 1000;
    if (madeAt && ageMs > FRESH_MS) {
      const minutes = Math.round(ageMs / 60_000);
      log.info(`${sha.slice(0, 8)} was committed ${minutes}m ago — not new, ignoring`);
      return;
    }

    log.info(`New commit ${sha.slice(0, 8)} detected`);
    this.onCommit(sha);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
