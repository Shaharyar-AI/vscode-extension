/**
 * Everything the engine needs from git. All deterministic, all here — the
 * model never runs a git command.
 */

import { basename } from "node:path";
import { run, runOrThrow } from "./proc";
import { languageFor } from "./languages";
import type { ChangeType, DiffStats, FileChange, RepoContext, Scope } from "./types";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runOrThrow("git", args, { cwd, timeoutMs: 30_000 })).trim();
}

/** Soft variant: returns "" instead of throwing. For best-effort metadata. */
async function gitSoft(cwd: string, args: string[]): Promise<string> {
  try {
    const r = await run("git", args, { cwd, timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await gitSoft(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

/** The diff arguments for a given scope. Resolved once, used everywhere. */
export function diffArgs(scope: Scope, baseBranch: string): string[] {
  switch (scope) {
    case "staged":
      return ["diff", "--cached"];
    case "all":
      return ["diff", "HEAD"];
    case "committed":
      return ["diff", `${baseBranch}...HEAD`];
  }
}

export async function readRepoContext(cwd: string): Promise<RepoContext> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const remote = await gitSoft(root, ["config", "--get", "remote.origin.url"]);
  const branch = (await gitSoft(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
  const head = await gitSoft(root, ["rev-parse", "HEAD"]);
  const headShort = await gitSoft(root, ["rev-parse", "--short", "HEAD"]);
  const status = await gitSoft(root, ["status", "--porcelain"]);

  let baseBranch = branch;
  for (const candidate of ["main", "master"]) {
    const exists = await gitSoft(root, ["rev-parse", "--verify", "--quiet", candidate]);
    if (exists) {
      baseBranch = candidate;
      break;
    }
  }

  return {
    root,
    name: repoNameFrom(remote, root),
    remote,
    branch,
    baseBranch,
    head,
    headShort,
    isDirty: status.length > 0,
    developerName: await gitSoft(root, ["config", "user.name"]),
    developerEmail: await gitSoft(root, ["config", "user.email"]),
  };
}

function repoNameFrom(remote: string, root: string): string {
  if (!remote) return basename(root);
  const cleaned = remote.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = cleaned.split(/[/:]/);
  return parts[parts.length - 1] || basename(root);
}

/** The unified diff for the active scope. Empty string means nothing to review. */
export async function collectDiff(repo: RepoContext, scope: Scope): Promise<string> {
  return (await run("git", diffArgs(scope, repo.baseBranch), {
    cwd: repo.root,
    timeoutMs: 60_000,
  })).stdout;
}

const CHANGE_TYPES: Record<string, ChangeType> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
};

export async function collectStats(repo: RepoContext, scope: Scope): Promise<DiffStats> {
  const base = diffArgs(scope, repo.baseBranch);
  const numstat = await gitSoft(repo.root, [...base, "--numstat"]);
  const namestatus = await gitSoft(repo.root, [...base, "--name-status"]);

  const typeByPath = new Map<string, ChangeType>();
  for (const line of namestatus.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const code = (cols[0] ?? "").charAt(0);
    // Renames are "R100\told\tnew" — the new path is what we care about.
    const path = cols.length >= 3 ? cols[2] : cols[1];
    if (path) typeByPath.set(path, CHANGE_TYPES[code] ?? "modified");
  }

  const files: FileChange[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [addRaw, delRaw, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    if (!path) continue;
    // "-" means binary; count it as zero rather than NaN.
    const added = addRaw === "-" ? 0 : parseInt(addRaw ?? "0", 10) || 0;
    const removed = delRaw === "-" ? 0 : parseInt(delRaw ?? "0", 10) || 0;
    linesAdded += added;
    linesRemoved += removed;
    files.push({
      path,
      language: languageFor(path),
      linesAdded: added,
      linesRemoved: removed,
      changeType: typeByPath.get(path) ?? "modified",
    });
  }

  return { filesChanged: files.length, linesAdded, linesRemoved, files };
}
