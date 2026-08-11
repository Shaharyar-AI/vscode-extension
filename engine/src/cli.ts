#!/usr/bin/env node
/**
 * Phase 0 entrypoint — review a diff from the terminal, no VS Code involved.
 *
 *   cr-track                       review staged changes
 *   cr-track --scope all           staged + unstaged vs HEAD
 *   cr-track --scope committed     this branch vs its base
 *   cr-track --diff-file x.diff    review a saved diff (for eval runs)
 *   cr-track --dry-run             print the invocation, call nothing
 *   cr-track --json out.json       also write the raw result
 */

import { readFileSync, writeFileSync } from "node:fs";
import { installHint, locateClaude } from "./claude-cli";
import { collectDiff, collectStats, isRepo, readRepoContext } from "./git";
import { findReferencesDir } from "./prompt";
import { renderReview, summarize } from "./render";
import { runReview } from "./review";
import { DEFAULT_CONFIG, type EngineConfig, type Scope } from "./types";

interface Args {
  scope: Scope;
  cwd: string;
  diffFile?: string;
  jsonOut?: string;
  dryRun: boolean;
  verbose: boolean;
  claudePath?: string;
  config: Partial<EngineConfig>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { scope: "staged", cwd: process.cwd(), dryRun: false, verbose: false, config: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "--scope": a.scope = next() as Scope; break;
      case "--cwd": a.cwd = next() ?? a.cwd; break;
      case "--diff-file": a.diffFile = next(); break;
      case "--json": a.jsonOut = next(); break;
      case "--claude-path": a.claudePath = next(); break;
      case "--model": a.config.model = next(); break;
      case "--effort": a.config.effort = next() as EngineConfig["effort"]; break;
      case "--profile": a.config.profile = next() as EngineConfig["profile"]; break;
      case "--min-severity": a.config.minSeverity = next() as EngineConfig["minSeverity"]; break;
      case "--budget": a.config.maxBudgetUsd = Number(next()); break;
      case "--timeout": a.config.timeoutMs = Number(next()) * 1000; break;
      case "--dry-run": a.dryRun = true; break;
      case "-v": case "--verbose": a.verbose = true; break;
      case "-h": case "--help": printHelp(); process.exit(0);
      default:
        if (k?.startsWith("-")) {
          console.error(`cr-track: unknown option ${k}`);
          process.exit(2);
        }
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`
cr-track — CR-Track review engine (phase 0)

Usage: cr-track [options]

  --scope <s>         staged (default) | all | committed
  --cwd <path>        repository to review (default: cwd)
  --diff-file <path>  review a saved diff instead of running git
  --json <path>       write the full result as JSON
  --dry-run           print the invocation without calling the model
  --claude-path <p>   override CLI discovery
  --model <id>        default ${DEFAULT_CONFIG.model}
  --effort <e>        low | medium | high | xhigh | max   (default ${DEFAULT_CONFIG.effort})
  --profile <p>       chill | balanced | assertive        (default ${DEFAULT_CONFIG.profile})
  --min-severity <s>  blocking | important | nit | suggestion
  --budget <usd>      optional spend cap; 0 (default) means no cap
  --timeout <sec>     default ${DEFAULT_CONFIG.timeoutMs / 1000}
  -v, --verbose       show the invocation and raw stdout

Exit codes: 0 clean or advisory only · 1 blocking findings · 2 could not review
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!(await isRepo(args.cwd))) {
    console.error(`cr-track: ${args.cwd} is not inside a git repository.`);
    return 2;
  }
  const repo = await readRepoContext(args.cwd);

  const diff = args.diffFile
    ? readFileSync(args.diffFile, "utf8")
    : await collectDiff(repo, args.scope);

  if (!diff.trim()) {
    console.error(
      args.scope === "staged"
        ? "cr-track: nothing staged — `git add` the changes you want reviewed."
        : `cr-track: no changes found for scope "${args.scope}".`,
    );
    return 2;
  }

  const stats = await collectStats(repo, args.scope);
  const changedPaths = args.diffFile ? pathsFromDiff(diff) : stats.files.map((f) => f.path);

  const cli = await locateClaude(args.claudePath);
  if (!cli.ok && !args.dryRun) {
    console.error(`cr-track: ${installHint(cli)}`);
    if (args.verbose) console.error(`  ${cli.detail}`);
    return 2;
  }
  // --dry-run inspects the invocation, so it must work without the binary.
  const claudePath = cli.ok ? cli.path : "claude";
  if (!cli.ok) console.error(`cr-track: ${installHint(cli)} (dry run continues anyway)`);
  else if (args.verbose) console.error(`cr-track: using ${cli.path} (v${cli.version})`);

  const result = await runReview({
    claudePath,
    repoRoot: repo.root,
    diff,
    changedPaths,
    config: args.config,
    referencesDir: findReferencesDir(),
    dryRun: args.dryRun,
  });

  if (args.dryRun || args.verbose) {
    console.error("\n" + result.command.map(quoteForDisplay).join(" \\\n  ") + "\n  < <diff on stdin>\n");
  }
  if (args.dryRun) {
    console.error(`guides: ${result.guidesLoaded.join(", ") || "(none)"}`);
    console.error(`cache key: ${result.cacheKey}`);
    return 0;
  }

  if (result.error) {
    console.error(`cr-track: review failed — ${result.error}`);
    if (args.verbose && result.rawStdout) console.error("\n--- raw stdout ---\n" + result.rawStdout);
    return 2;
  }

  const config = { ...DEFAULT_CONFIG, ...args.config };
  process.stdout.write(
    renderReview(result.findings, result.annotations, stats, {
      durationMs: result.durationMs,
      model: config.model,
      effort: config.effort,
      guidesLoaded: result.guidesLoaded,
      cached: false,
    }),
  );

  if (args.jsonOut) {
    writeFileSync(
      args.jsonOut,
      JSON.stringify(
        {
          cacheKey: result.cacheKey,
          scope: args.scope,
          model: config.model,
          effort: config.effort,
          durationMs: result.durationMs,
          guidesLoaded: result.guidesLoaded,
          repo: { name: repo.name, branch: repo.branch, head: repo.headShort },
          diffStats: stats,
          findings: result.findings,
          annotations: result.annotations,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.error(`cr-track: wrote ${args.jsonOut}`);
  }

  return summarize(result.findings).blocking > 0 ? 1 : 0;
}

/** Fall back to reading paths out of the diff itself for --diff-file runs. */
function pathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m && m[1] && m[1] !== "/dev/null") paths.add(m[1]);
  }
  return [...paths];
}

function quoteForDisplay(s: string): string {
  if (s.length > 120) return `'<${s.length} chars>'`;
  return /[\s"']/.test(s) ? `'${s}'` : s;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`cr-track: ${(err as Error).message}`);
    process.exit(2);
  });
