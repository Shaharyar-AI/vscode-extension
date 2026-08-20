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
import { headSha, lastRefAction } from "@engine/git";
import { log } from "./log";

/** Reflog actions that mean "the developer committed something". */
const COMMIT_ACTIONS = new Set(["commit", "commit (amend)", "commit (initial)", "commit (merge)"]);

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
    if (!sha || sha === this.lastSeen) return;

    const action = await lastRefAction(this.repoRoot);
    this.lastSeen = sha;

    if (!COMMIT_ACTIONS.has(action)) {
      log.info(`HEAD moved to ${sha.slice(0, 8)} via "${action}" — not a commit, ignoring`);
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
