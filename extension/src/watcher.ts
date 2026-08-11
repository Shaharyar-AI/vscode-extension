/**
 * Watches the git index and reports when the staged set has settled.
 *
 * Watching `.git/index` directly rather than going through the Git extension's
 * API: the index file is touched on every stage/unstage regardless of whether
 * the change came from VS Code, a terminal, or another tool. Staging is bursty
 * — `git add -A` on twenty files fires many events — so everything is debounced
 * into a single "the developer has finished staging" signal.
 */

import { join } from "node:path";
import * as vscode from "vscode";
import { log } from "./log";

export class IndexWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly repoRoot: string,
    private readonly debounceMs: () => number,
    private readonly onSettled: () => void,
  ) {
    // A RelativePattern keeps this scoped to one repo's index rather than
    // every file in the workspace.
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(join(repoRoot, ".git")),
      "index",
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => this.schedule());
    this.watcher.onDidCreate(() => this.schedule());
    log.info(`Watching ${join(repoRoot, ".git", "index")}`);
  }

  /** Restart the debounce window. Rapid staging collapses into one review. */
  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) this.onSettled();
    }, this.debounceMs());
  }

  /** Trigger immediately, cancelling any pending debounce. */
  fireNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.disposed) this.onSettled();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.dispose();
    log.info(`Stopped watching ${this.repoRoot}`);
  }
}
