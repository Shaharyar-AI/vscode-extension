/**
 * Everything the engine needs from git. All deterministic, all here — the
 * model never runs a git command.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { run, runOrThrow } from "./proc";
import { languageFor } from "./languages";
import type { ChangeType, DiffStats, FileChange, RepoContext, Scope } from "./types";

/**
 * Which git to run.
 *
 * `git` on PATH is the normal answer, but the extension host does not always
 * inherit a PATH containing it — Windows machines where git arrived with
 * GitHub Desktop are the common case. VS Code's own `git.path` setting is the
 * override, which is why Source Control can work while a plain spawn fails.
 */
let GIT = "git";

export function setGitPath(path: string | undefined): void {
  GIT = path?.trim() || "git";
}

export function gitPath(): string {
  return GIT;
}

/** Places git actually installs to when it is not on PATH. */
function gitCandidates(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    return [
      join(pf, "Git", "cmd", "git.exe"),
      join(pf86, "Git", "cmd", "git.exe"),
      join(local, "Programs", "Git", "cmd", "git.exe"),
      // GitHub Desktop ships its own git and never touches PATH.
      join(local, "GitHubDesktop", "app", "resources", "app", "git", "cmd", "git.exe"),
      join(pf, "Git", "bin", "git.exe"),
    ];
  }
  return [
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
  ];
}

/**
 * Find a usable git.
 *
 * Tried in order: an explicit override, PATH, then known install locations.
 * The last step is what saves the machines where git exists and simply is not
 * on the PATH the editor inherited — a case that otherwise presents as "this
 * folder is not a git repository", which is both wrong and unactionable.
 */
export async function locateGit(override?: string): Promise<{ path: string; version: string } | null> {
  const tried = [override, "git", ...gitCandidates()].filter(Boolean) as string[];

  for (const candidate of tried) {
    if (candidate !== "git" && candidate !== override && !existsSync(candidate)) continue;
    try {
      const r = await run(candidate, ["--version"], { timeoutMs: 10_000 });
      if (r.code !== 0) continue;
      const version = r.stdout.trim().replace(/^git version\s*/i, "");
      GIT = candidate;
      return { path: candidate, version };
    } catch {
      // ENOENT for a name that is not on PATH — keep looking.
    }
  }
  return null;
}

/**
 * Windows refuses to operate on a repository owned by another user, which is
 * common on a second drive or a cloned profile. The fix is one command, so it
 * is worth detecting precisely rather than lumping in with other errors.
 */
export function isDubiousOwnership(detail: string): boolean {
  return /dubious ownership|safe\.directory/i.test(detail);
}

export async function trustDirectory(dir: string): Promise<boolean> {
  const r = await run(GIT, ["config", "--global", "--add", "safe.directory", dir], {
    timeoutMs: 15_000,
  });
  return r.code === 0;
}

/**
 * Walk up looking for a repository.
 *
 * Opening a subdirectory of a repo is normal, and so is opening a parent that
 * contains one. Checking only the folder that happens to be open turns both
 * into "not a git repository".
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  const r = await run(GIT, ["rev-parse", "--show-toplevel"], { cwd: startDir, timeoutMs: 15_000 });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runOrThrow(GIT, args, { cwd, timeoutMs: 30_000 })).trim();
}

/** Soft variant: returns "" instead of throwing. For best-effort metadata. */
async function gitSoft(cwd: string, args: string[]): Promise<string> {
  try {
    const r = await run(GIT, args, { cwd, timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

export type RepoCheck =
  | { ok: true }
  | { ok: false; reason: "git-missing" | "git-error" | "not-a-repo"; detail: string };

/**
 * Is this a usable git repository?
 *
 * Distinguishing the failures matters. "Not a git repository" is the right
 * thing to tell someone whose folder genuinely has no `.git`, and actively
 * misleading for someone whose git is missing from PATH, or who has tripped
 * Windows' dubious-ownership check — all of which look identical if you only
 * test the exit code.
 */
export async function checkRepo(cwd: string): Promise<RepoCheck> {
  let r;
  try {
    r = await run(GIT, ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 30_000 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: "git-missing",
        detail:
          `\`${GIT}\` could not be run — git is not on the PATH this window inherited. ` +
          `Set "git.path" in settings, or relaunch VS Code from a terminal where \`git --version\` works.`,
      };
    }
    return { ok: false, reason: "git-error", detail: (err as Error).message };
  }

  if (r.code === 0 && r.stdout.trim() === "true") return { ok: true };

  const stderr = (r.stderr || r.stdout).trim();
  if (/not a git repository/i.test(stderr)) {
    return { ok: false, reason: "not-a-repo", detail: stderr };
  }
  // Dubious ownership, a broken index, a permissions problem — report what git
  // actually said instead of guessing.
  return {
    ok: false,
    reason: "git-error",
    detail: stderr || `\`git rev-parse\` exited ${r.code} with no output`,
  };
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await checkRepo(cwd)).ok;
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

/**
 * How many files are changed but not staged, including untracked ones.
 *
 * Used to tell "there is nothing to review" apart from "there is plenty to
 * review, you just haven't staged it" — which look identical otherwise and
 * make the extension appear broken.
 */
export async function countUnstaged(repo: RepoContext): Promise<number> {
  const status = await gitSoft(repo.root, ["status", "--porcelain"]);
  if (!status) return 0;
  let n = 0;
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Columns are [index][worktree]. A non-space worktree column means the
    // change is not staged; "??" is untracked.
    const worktree = line[1];
    if (line.startsWith("??") || (worktree && worktree !== " ")) n++;
  }
  return n;
}

/** The unified diff for the active scope. Empty string means nothing to review. */
export async function collectDiff(repo: RepoContext, scope: Scope): Promise<string> {
  return (await run(GIT, diffArgs(scope, repo.baseBranch), {
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
