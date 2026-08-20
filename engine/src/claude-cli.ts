/**
 * Locating and vetting the Claude CLI.
 *
 * The CLI is a dependency we do not control, so every failure here is a
 * structured "unavailable" result rather than a thrown error. Callers decide
 * how loudly to complain; the commit must never be blocked by it.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./proc";

/** Bump when we start relying on a newer flag. */
export const MIN_CLI_VERSION = "2.0.0";

/**
 * How long one `claude --version` may take.
 *
 * Generous on purpose. The CLI starts a Node runtime, and on a cold Windows
 * machine with an antivirus scanner in the path that has been measured at over
 * twenty seconds. The previous fifteen-second limit meant every candidate timed
 * out on exactly those machines and the extension reported the CLI as missing
 * on a machine where it plainly worked.
 */
const VERSION_PROBE_MS = 60_000;

export type CliStatus =
  | { ok: true; path: string; version: string }
  | {
      ok: false;
      reason: "not-found" | "too-old" | "unusable";
      detail: string;
      path?: string;
      /** Every candidate that was run, and why it was rejected. */
      attempts?: { path: string; why: string }[];
    };

const isWindows = process.platform === "win32";

/** Splits command output into lines on either line ending. */
const LINE_BREAK = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));

/** Every directory a `claude` shim could live in, per Node version manager. */
function versionManagerBins(home: string): string[] {
  const roots = [
    join(home, ".nvm", "versions", "node"),
    join(home, ".local", "share", "fnm", "node-versions"),
    join(home, "Library", "Application Support", "fnm", "node-versions"),
    join(home, ".volta", "tools", "image", "node"),
  ];
  const out: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Newest first, so an upgraded CLI wins over one left behind by an older
    // Node version that happens to still be installed.
    for (const entry of entries.sort().reverse()) {
      out.push(join(root, entry, "bin", "claude"));
      out.push(join(root, entry, "installation", "bin", "claude"));
    }
  }
  return out;
}

/**
 * The `claude` bundled inside the Claude Code editor extension.
 *
 * This is the one that mattered most in practice. Someone who installs Claude
 * Code from the VS Code marketplace gets a working Claude terminal and *no*
 * `claude` on PATH at all — the binary lives inside the extension directory.
 * They will tell you, correctly, that they have Claude installed, and every
 * other lookup here will disagree with them.
 */
function editorExtensionBins(home: string): string[] {
  const roots = [
    process.env["VSCODE_EXTENSIONS"],
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".vscode-server", "extensions"),
    join(home, ".vscode-oss", "extensions"),
    join(home, ".cursor", "extensions"),
    join(home, ".cursor-server", "extensions"),
    join(home, ".windsurf", "extensions"),
  ].filter((p): p is string => Boolean(p));

  const out: string[] = [];
  const binary = isWindows ? "claude.exe" : "claude";

  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Newest first: several versions of the extension are commonly left behind,
    // and the highest is the one the editor is actually running.
    const mine = entries
      .filter((e) => e.startsWith("anthropic.claude-code"))
      .sort()
      .reverse();
    for (const entry of mine) {
      out.push(join(root, entry, "resources", "native-binary", binary));
      // Older layouts put it a level up.
      out.push(join(root, entry, "resources", binary));
      out.push(join(root, entry, "bin", binary));
    }
  }
  return out;
}

function candidatePaths(): string[] {
  const home = homedir();
  const out: string[] = [];
  // Ahead of everything else: an editor that bundles Claude is running that
  // copy, and matching it avoids a version mismatch as well as a not-found.
  out.push(...editorExtensionBins(home));
  if (isWindows) {
    const appdata = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    out.push(
      join(appdata, "npm", "claude.cmd"),
      join(local, "Programs", "claude", "claude.exe"),
      join(home, ".claude", "local", "claude.exe"),
      join(home, ".local", "bin", "claude.exe"),
      join(local, "Volta", "bin", "claude.exe"),
    );
  } else {
    out.push(
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/bin/claude",
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
      join(home, ".bun", "bin", "claude"),
      join(home, ".volta", "bin", "claude"),
      join(home, ".asdf", "shims", "claude"),
      join(home, ".yarn", "bin", "claude"),
      join(home, ".npm-global", "bin", "claude"),
      join(home, "Library", "pnpm", "claude"),
      join(home, ".local", "share", "pnpm", "claude"),
      join(home, "npm", "bin", "claude"),
      ...versionManagerBins(home),
    );
  }
  return out;
}

/** Ask the OS where `claude` lives. Returns the first hit, or null. */
async function fromPath(): Promise<string | null> {
  const finder = isWindows ? "where" : "which";
  try {
    const r = await run(finder, ["claude"], { timeoutMs: 5_000 });
    if (r.code !== 0) return null;
    const first = r.stdout.split(LINE_BREAK).map((l) => l.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask the user's login shell where `claude` is.
 *
 * This exists for one specific, very common failure. VS Code launched from the
 * Dock or a desktop icon inherits a bare PATH — roughly `/usr/bin:/bin` — not
 * the one built by `.zshrc` or `.bashrc`. Anyone whose Node came from nvm, fnm
 * or asdf then has a `claude` that works perfectly in their terminal and is
 * invisible to the extension, which is indistinguishable from the extension
 * being broken.
 *
 * `-l` sources login files and `-i` sources interactive ones; nvm is normally
 * set up in the latter, so both are tried. Startup files can print banners, so
 * only a line that is an absolute path to a file that exists is believed.
 */
async function fromLoginShell(): Promise<string | null> {
  if (isWindows) return null;
  const shell = process.env["SHELL"];
  if (!shell || !existsSync(shell)) return null;

  for (const flag of ["-lic", "-lc"]) {
    try {
      const r = await run(shell, [flag, "command -v claude"], { timeoutMs: 10_000 });
      const hit = r.stdout
        .split(LINE_BREAK)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/") && existsSync(l))
        .pop();
      if (hit) return hit;
    } catch {
      // A shell that refuses to start this way is not an error worth reporting.
    }
  }
  return null;
}

/** Numeric-segment comparison. Returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Resolve the CLI. `override` comes from configuration (the extension will
 * surface this as a `crTrack.claudePath` setting).
 */
export interface LocateOptions {
  /** Called when an explicitly configured path could not be used. */
  onOverrideRejected?: (path: string, reason: string) => void;
}

/** Does at least one candidate answer `--version` successfully? */
async function anyRunnable(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      const r = await run(path, ["--version"], { timeoutMs: VERSION_PROBE_MS });
      if (r.code === 0) return true;
    } catch {
      /* try the next one */
    }
  }
  return false;
}

export async function locateClaude(
  override?: string,
  options: LocateOptions = {},
): Promise<CliStatus> {
  const tried: string[] = [];
  // Why each candidate was rejected. Without this a "not found" is unarguable
  // and undiagnosable — the user can see the binary and we cannot say what we
  // did with it.
  const attempts: { path: string; why: string }[] = [];

  const candidates: string[] = [];
  if (override) candidates.push(override);
  const onPath = await fromPath();
  if (onPath) candidates.push(onPath);
  candidates.push(...candidatePaths().filter(existsSync));

  // Last, because it is the slowest: starting a login shell can take seconds.
  // It is also the only thing that finds an nvm/fnm install when the editor was
  // launched from the Dock, so it must run before we conclude "not found".
  if (candidates.length === 0 || !(await anyRunnable(candidates))) {
    const fromShell = await fromLoginShell();
    if (fromShell && !candidates.includes(fromShell)) candidates.push(fromShell);
  }

  for (const path of candidates) {
    tried.push(path);
    let out: string;
    try {
      const r = await run(path, ["--version"], { timeoutMs: VERSION_PROBE_MS });
      if (r.code !== 0) {
        attempts.push({ path, why: `exited ${r.code}${r.timedOut ? " (timed out)" : ""}` });
        // Falling through to another CLI is right — refusing to work because a
        // stale setting points nowhere would be worse. Saying nothing is not:
        // the setting would appear to have no effect at all.
        if (path === override) {
          options.onOverrideRejected?.(path, `exited ${r.code}`);
        }
        continue;
      }
      out = r.stdout.trim();
    } catch (err) {
      attempts.push({ path, why: (err as NodeJS.ErrnoException).code ?? (err as Error).message });
      if (path === override) {
        options.onOverrideRejected?.(path, (err as NodeJS.ErrnoException).code ?? "could not run it");
      }
      continue;
    }

    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (!m || !m[1]) {
      return { ok: false, reason: "unusable", path, detail: `could not parse a version from "${out}"` };
    }
    const version = m[1];
    if (compareVersions(version, MIN_CLI_VERSION) < 0) {
      return {
        ok: false,
        reason: "too-old",
        path,
        detail: `found ${version}, need ${MIN_CLI_VERSION} or newer — run \`claude update\``,
      };
    }
    return { ok: true, path, version };
  }

  return {
    ok: false,
    reason: "not-found",
    attempts,
    detail:
      attempts.length > 0
        ? attempts.map((a) => `${a.path} (${a.why})`).join("; ")
        : tried.length > 0
          ? `checked: ${tried.join(", ")}`
          : "not on PATH and not in any known install location",
  };
}

/** Human-readable guidance for a failed lookup. */
export function installHint(status: Extract<CliStatus, { ok: false }>): string {
  switch (status.reason) {
    case "not-found":
      return (
        "the Claude CLI could not be found. If `claude` works in your terminal, " +
        "run `which claude` there and put that path in the crTrack.claudePath setting. " +
        "Otherwise:  npm i -g @anthropic-ai/claude-code"
      );
    case "too-old":
      return `Claude CLI is out of date (${status.detail}).`;
    case "unusable":
      return `Claude CLI found at ${status.path} but did not respond as expected (${status.detail}).`;
  }
}
