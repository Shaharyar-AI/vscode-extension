/**
 * Runs reviews, one repo at a time.
 *
 * Two rules make this behave under real editing:
 *
 *  1. A newer change supersedes an older one. If the developer stages again
 *     while a review is in flight, the running CLI process is killed — its
 *     answer describes a diff that no longer exists.
 *  2. Results are cached by diff hash. Staging, unstaging and re-staging the
 *     same content is common, and it should not pay for a second review.
 */

import * as vscode from "vscode";
import { collectDiff, collectStats, readRepoContext } from "@engine/git";
import { findReferencesDir } from "@engine/prompt";
import { cacheKeyFor, runReview } from "@engine/review";
import { guidesFor } from "@engine/languages";
import type { Annotation, DiffStats, Finding, RepoContext } from "@engine/types";
import type { Settings } from "./config";
import { log } from "./log";

export interface ReviewOutcome {
  findings: Finding[];
  annotations: Annotation[];
  stats: DiffStats;
  repo: RepoContext;
  cacheKey: string;
  durationMs: number;
  fromCache: boolean;
  error?: string;
}

export type State =
  | { kind: "idle" }
  | { kind: "running"; startedAt: number }
  | { kind: "done"; outcome: ReviewOutcome }
  | { kind: "failed"; message: string };

const MAX_CACHE_ENTRIES = 40;

export class Orchestrator implements vscode.Disposable {
  private cancelCurrent: (() => void) | undefined;
  private runToken = 0;
  private readonly cache = new Map<string, ReviewOutcome>();
  private readonly emitter = new vscode.EventEmitter<State>();

  readonly onDidChangeState = this.emitter.event;
  state: State = { kind: "idle" };

  constructor(
    private readonly repoRoot: string,
    private readonly claudePath: string,
    private readonly settings: () => Settings,
  ) {}

  /**
   * Review the current staged set. Safe to call repeatedly; each call
   * supersedes the last.
   */
  async review(options: { force?: boolean } = {}): Promise<ReviewOutcome | undefined> {
    const token = ++this.runToken;
    this.cancelInFlight();

    const cfg = this.settings();
    let repo: RepoContext;
    try {
      repo = await readRepoContext(this.repoRoot);
    } catch (err) {
      return this.fail(token, `not a git repository: ${(err as Error).message}`);
    }

    const diff = await collectDiff(repo, "staged");
    if (!diff.trim()) {
      this.setState({ kind: "idle" });
      return undefined;
    }

    const key = cacheKeyFor(diff, cfg, guidesFor((await collectStats(repo, "staged")).files.map((f) => f.path)));
    if (!options.force) {
      const hit = this.cache.get(key);
      if (hit) {
        log.info(`Cache hit ${key.slice(0, 8)} — ${hit.findings.length} finding(s)`);
        const outcome = { ...hit, fromCache: true };
        this.setState({ kind: "done", outcome });
        return outcome;
      }
    }

    const stats = await collectStats(repo, "staged");
    this.setState({ kind: "running", startedAt: Date.now() });
    log.info(
      `Reviewing ${stats.filesChanged} file(s), +${stats.linesAdded}/-${stats.linesRemoved} ` +
        `(${cfg.model}, effort ${cfg.effort})`,
    );

    let result;
    try {
      result = await runReview({
        claudePath: this.claudePath,
        repoRoot: repo.root,
        diff,
        changedPaths: stats.files.map((f) => f.path),
        config: cfg,
        referencesDir: findReferencesDir(),
        onSpawn: (kill) => {
          // Only the newest run owns the cancel handle.
          if (token === this.runToken) this.cancelCurrent = kill;
        },
      });
    } catch (err) {
      return this.fail(token, (err as Error).message);
    } finally {
      if (token === this.runToken) this.cancelCurrent = undefined;
    }

    // A newer review started while this one ran — its answer is stale.
    if (token !== this.runToken) {
      log.info("Discarded a superseded review");
      return undefined;
    }

    if (result.error) return this.fail(token, result.error);

    const outcome: ReviewOutcome = {
      findings: result.findings,
      annotations: result.annotations,
      stats,
      repo,
      cacheKey: key,
      durationMs: result.durationMs,
      fromCache: false,
    };

    this.remember(key, outcome);
    log.info(
      `Review complete in ${(result.durationMs / 1000).toFixed(0)}s — ` +
        `${result.findings.length} finding(s), ${result.annotations.length} note(s)`,
    );
    this.setState({ kind: "done", outcome });
    return outcome;
  }

  /** Kill the running CLI process, if any. */
  cancelInFlight(): void {
    if (!this.cancelCurrent) return;
    log.info("Cancelling in-flight review");
    try {
      this.cancelCurrent();
    } catch {
      /* already gone */
    }
    this.cancelCurrent = undefined;
  }

  /** Abandon any running review and forget the current result. */
  reset(): void {
    this.runToken++;
    this.cancelInFlight();
    this.setState({ kind: "idle" });
  }

  private remember(key: string, outcome: ReviewOutcome): void {
    this.cache.set(key, outcome);
    // Bounded, insertion-ordered: drop the oldest entries first.
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private fail(token: number, message: string): undefined {
    if (token !== this.runToken) return undefined;
    log.warn(`Review failed: ${message}`);
    this.setState({ kind: "failed", message });
    return undefined;
  }

  private setState(state: State): void {
    this.state = state;
    this.emitter.fire(state);
  }

  dispose(): void {
    this.cancelInFlight();
    this.emitter.dispose();
  }
}
