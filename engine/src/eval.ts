#!/usr/bin/env node
/**
 * Phase 0.5 — the eval harness.
 *
 * Replays real commits from real repositories through the engine and reports
 * what came back, so finding quality can be judged before anything is built on
 * top of it. Precision is the number that matters: a reviewer nobody trusts is
 * worse than no reviewer.
 *
 *   node dist/eval.js --out evalrun --limit 4 C:/ikonic/lms C:/ikonic/website
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { locateClaude } from "./claude-cli";
import { languageFor } from "./languages";
import { run } from "./proc";
import { findReferencesDir } from "./prompt";
import { runReview } from "./review";
import {
  CATEGORIES,
  DEFAULT_CONFIG,
  SEVERITY_ORDER,
  type Category,
  type EngineConfig,
  type Finding,
  type Severity,
} from "./types";

interface Target {
  repo: string;
  repoName: string;
  sha: string;
  subject: string;
  files: number;
  lines: number;
  paths: string[];
}

interface Outcome extends Target {
  findings: Finding[];
  durationMs: number;
  guidesLoaded: string[];
  /** How many tool-use turns the model took before answering. */
  turns: number | null;
  error?: string;
}

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".sql",
]);

const isCode = (p: string) => {
  const dot = p.lastIndexOf(".");
  return dot > -1 && CODE_EXT.has(p.slice(dot).toLowerCase());
};

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run("git", args, { cwd, timeoutMs: 60_000 });
  return r.code === 0 ? r.stdout : "";
}

/** Most recent commits that actually touch code and are a sane size. */
async function pickCommits(repo: string, limit: number, maxLines: number): Promise<Target[]> {
  const log = await git(repo, ["log", "--format=%H%x1f%s", "-n", "250", "--no-merges"]);
  const repoName = basename(repo);
  const out: Target[] = [];

  for (const line of log.split(/\r?\n/)) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    const [sha, subject] = line.split("\x1f");
    if (!sha) continue;

    const numstat = await git(repo, ["show", "--numstat", "--format=", sha]);
    let lines = 0;
    const paths: string[] = [];
    for (const row of numstat.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const [a, d, ...rest] = row.split("\t");
      const p = rest[rest.length - 1];
      if (!p || !isCode(p)) continue;
      paths.push(p);
      lines += (a === "-" ? 0 : parseInt(a ?? "0", 10) || 0) + (d === "-" ? 0 : parseInt(d ?? "0", 10) || 0);
    }
    if (paths.length === 0 || lines === 0 || lines > maxLines) continue;
    out.push({ repo, repoName, sha, subject: subject ?? "", files: paths.length, lines, paths });
  }
  return out;
}

/** The diff for one commit, restricted to code files. */
async function diffFor(t: Target): Promise<string> {
  return git(t.repo, ["show", "--format=", "--unified=3", t.sha, "--", ...t.paths]);
}

async function pool<T, R>(items: T[], size: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function bar(n: number, max: number, width = 22): string {
  if (max <= 0) return "";
  return "\u2588".repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width)));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let outDir = "evalrun";
  let limit = 4;
  let maxLines = 900;
  let concurrency = 2;
  const config: Partial<EngineConfig> = {};
  const repos: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = () => argv[++i]!;
    if (k === "--out") outDir = next();
    else if (k === "--limit") limit = Number(next());
    else if (k === "--max-lines") maxLines = Number(next());
    else if (k === "--concurrency") concurrency = Number(next());
    else if (k === "--effort") config.effort = next() as EngineConfig["effort"];
    else if (k === "--model") config.model = next();
    else if (k === "--profile") config.profile = next() as EngineConfig["profile"];
    else if (!k.startsWith("-")) repos.push(k);
  }

  if (repos.length === 0) {
    console.error("usage: eval --out <dir> [--limit N] [--max-lines N] <repo> [<repo>...]");
    return 2;
  }

  const cli = await locateClaude();
  if (!cli.ok) {
    console.error(`eval: Claude CLI unavailable — ${cli.detail}`);
    return 2;
  }

  const targets: Target[] = [];
  for (const repo of repos) {
    if (!existsSync(join(repo, ".git"))) {
      console.error(`eval: skipping ${repo} (not a git repo)`);
      continue;
    }
    const picked = await pickCommits(repo, limit, maxLines);
    targets.push(...picked);
    console.error(`eval: ${basename(repo)} — ${picked.length} commit(s) selected`);
  }
  if (targets.length === 0) {
    console.error("eval: nothing to review");
    return 2;
  }

  const cfg = { ...DEFAULT_CONFIG, ...config };
  console.error(
    `\neval: ${targets.length} reviews · ${cfg.model} · effort ${cfg.effort} · concurrency ${concurrency}\n`,
  );

  const referencesDir = findReferencesDir();
  const started = Date.now();
  let done = 0;

  const outcomes = await pool(targets, concurrency, async (t): Promise<Outcome> => {
    const diff = await diffFor(t);
    const blank = { turns: null };
    if (!diff.trim()) {
      return { ...t, findings: [], durationMs: 0, guidesLoaded: [], ...blank, error: "empty diff" };
    }
    const r = await runReview({
      claudePath: cli.path,
      repoRoot: t.repo,
      diff,
      changedPaths: t.paths,
      config,
      referencesDir,
    });
    done++;
    const tag = r.error ? "ERR " : padL(String(r.findings.length), 3);
    const turns = r.usage?.turns != null ? `${r.usage.turns}t` : " -";
    console.error(
      `  [${padL(String(done), 2)}/${targets.length}] ${tag} ${pad(t.repoName, 14)} ${t.sha.slice(0, 8)} ` +
        `${padL(`${t.files}f/${t.lines}L`, 10)} ${padL(`${(r.durationMs / 1000).toFixed(0)}s`, 5)} ` +
        `${padL(turns, 4)}  ${t.subject.slice(0, 44)}`,
    );
    return {
      ...t,
      findings: r.findings,
      durationMs: r.durationMs,
      guidesLoaded: r.guidesLoaded,
      turns: r.usage?.turns ?? null,
      ...(r.error ? { error: r.error } : {}),
    };
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "results.json"), JSON.stringify(outcomes, null, 2), "utf8");
  writeFileSync(join(outDir, "report.md"), markdownReport(outcomes), "utf8");

  printSummary(outcomes, Date.now() - started, cfg);
  console.error(`\nwrote ${join(outDir, "results.json")} and report.md\n`);
  return 0;
}

function printSummary(outcomes: Outcome[], wallMs: number, cfg: EngineConfig): void {
  const ok = outcomes.filter((o) => !o.error);
  const all = ok.flatMap((o) => o.findings);
  const totalLines = ok.reduce((s, o) => s + o.lines, 0);

  const bySev: Record<Severity, number> = { blocking: 0, important: 0, nit: 0, suggestion: 0 };
  for (const f of all) if (f.severity in bySev) bySev[f.severity]++;

  const byCat = new Map<Category, number>();
  for (const f of all) byCat.set(f.category, (byCat.get(f.category) ?? 0) + 1);

  const L = (s = "") => console.log(s);
  L();
  L("═".repeat(72));
  L(`  EVAL — ${ok.length}/${outcomes.length} reviews completed`);
  L("═".repeat(72));
  L();
  L(`  ${all.length} findings across ${totalLines} changed lines` +
    `  (${((all.length / Math.max(totalLines, 1)) * 100).toFixed(1)} per 100 lines)`);
  L(`  ${(all.length / Math.max(ok.length, 1)).toFixed(1)} findings per commit` +
    `   ·  ${(ok.reduce((s, o) => s + o.durationMs, 0) / Math.max(ok.length, 1) / 1000).toFixed(0)}s median-ish per review` +
    `   ·  ${(wallMs / 1000 / 60).toFixed(1)} min wall clock`);
  L();

  const maxSev = Math.max(...Object.values(bySev), 1);
  L("  BY SEVERITY");
  for (const s of SEVERITY_ORDER) {
    L(`    ${pad(s, 12)} ${padL(String(bySev[s]), 4)}  ${bar(bySev[s], maxSev)}`);
  }
  L();

  const maxCat = Math.max(...[...byCat.values()], 1);
  L("  BY CATEGORY");
  for (const c of CATEGORIES) {
    const n = byCat.get(c) ?? 0;
    if (n === 0) continue;
    L(`    ${pad(c, 16)} ${padL(String(n), 4)}  ${bar(n, maxCat)}`);
  }
  L();

  const buckets = [0, 0, 0, 0, 0];
  for (const f of all) {
    const c = typeof f.confidence === "number" ? f.confidence : 0;
    buckets[Math.min(4, Math.max(0, Math.floor(c * 5)))]!++;
  }
  const maxB = Math.max(...buckets, 1);
  L("  CONFIDENCE");
  ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"].forEach((label, i) => {
    L(`    ${pad(label, 12)} ${padL(String(buckets[i]!), 4)}  ${bar(buckets[i]!, maxB)}`);
  });
  L();

  const quiet = ok.filter((o) => o.findings.length === 0);
  const noisy = [...ok].sort((a, b) => b.findings.length - a.findings.length).slice(0, 3);
  L("  DISTRIBUTION");
  L(`    clean commits (0 findings)   ${quiet.length}/${ok.length}`);
  L(`    busiest                      ${noisy.map((o) => `${o.sha.slice(0, 7)}=${o.findings.length}`).join("  ")}`);
  const blocking = ok.filter((o) => o.findings.some((f) => f.severity === "blocking"));
  L(`    commits with a blocker       ${blocking.length}/${ok.length}`);
  L();

  const failed = outcomes.filter((o) => o.error);
  if (failed.length) {
    L("  FAILURES");
    for (const f of failed) L(`    ${f.sha.slice(0, 8)} ${pad(f.repoName, 20)} ${f.error}`);
    L();
  }

  const durations = ok.map((o) => o.durationMs).sort((a, b) => a - b);
  const turns = ok.map((o) => o.turns).filter((t): t is number => typeof t === "number");

  L("  RUN");
  if (durations.length) {
    L(`    latency  min/median/max      ${(durations[0]! / 1000).toFixed(0)}s / ` +
      `${(durations[Math.floor(durations.length / 2)]! / 1000).toFixed(0)}s / ` +
      `${(durations[durations.length - 1]! / 1000).toFixed(0)}s`);
  }
  if (turns.length) {
    L(`    agent turns  avg/max         ${(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1)} / ${Math.max(...turns)}` +
      `   (how much the model read before answering)`);
  }
  L(`    model                        ${cfg.model}, effort ${cfg.effort}`);
  L();
  L("  Next: open report.md and grade each finding true/false. Precision is the");
  L("  number that decides whether to keep building.");
  L();
}

function markdownReport(outcomes: Outcome[]): string {
  const out: string[] = ["# CR-Track eval run", ""];
  out.push("Grade each finding: `TP` real problem · `FP` false positive · `?` unsure.", "");

  for (const o of outcomes) {
    out.push(`## ${o.repoName} · \`${o.sha.slice(0, 8)}\` — ${o.subject}`);
    out.push(`${o.files} file(s), ${o.lines} lines changed · ${(o.durationMs / 1000).toFixed(0)}s`);
    out.push("");
    if (o.error) {
      out.push(`> review failed: ${o.error}`, "");
      continue;
    }
    if (o.findings.length === 0) {
      out.push("_No findings._", "");
      continue;
    }
    out.push("| grade | id | severity | category | location | finding |");
    out.push("|---|---|---|---|---|---|");
    for (const f of o.findings) {
      const loc = `${f.file}:${f.lineStart}${f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""}`;
      out.push(
        `|  | ${f.id} | ${f.severity} | ${f.category} | \`${loc}\` | ${f.title.replace(/\|/g, "\\|")} |`,
      );
    }
    out.push("");
    for (const f of o.findings) {
      out.push(`**${f.id}** (${Math.round((f.confidence ?? 0) * 100)}%) — ${f.description}`);
      out.push(`> ${f.suggestion}`, "");
    }
  }
  return out.join("\n");
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(`eval: ${(e as Error).message}`);
    process.exit(2);
  });
