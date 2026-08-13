/**
 * Locating and vetting the Claude CLI.
 *
 * The CLI is a dependency we do not control, so every failure here is a
 * structured "unavailable" result rather than a thrown error. Callers decide
 * how loudly to complain; the commit must never be blocked by it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./proc";

/** Bump when we start relying on a newer flag. */
export const MIN_CLI_VERSION = "2.0.0";

export type CliStatus =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: "not-found" | "too-old" | "unusable"; detail: string; path?: string };

const isWindows = process.platform === "win32";

function candidatePaths(): string[] {
  const home = homedir();
  const out: string[] = [];
  if (isWindows) {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    out.push(
      join(appdata, "npm", "claude.cmd"),
      join(local, "Programs", "claude", "claude.exe"),
      join(home, ".claude", "local", "claude.exe"),
      join(home, ".local", "bin", "claude.exe"),
    );
  } else {
    out.push(
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
      join(home, ".bun", "bin", "claude"),
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
    const first = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
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

export async function locateClaude(
  override?: string,
  options: LocateOptions = {},
): Promise<CliStatus> {
  const tried: string[] = [];

  const candidates: string[] = [];
  if (override) candidates.push(override);
  const onPath = await fromPath();
  if (onPath) candidates.push(onPath);
  candidates.push(...candidatePaths().filter(existsSync));

  for (const path of candidates) {
    tried.push(path);
    let out: string;
    try {
      const r = await run(path, ["--version"], { timeoutMs: 15_000 });
      if (r.code !== 0) {
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
    detail:
      tried.length > 0
        ? `checked: ${tried.join(", ")}`
        : "not on PATH and not in any known install location",
  };
}

/** Human-readable guidance for a failed lookup. */
export function installHint(status: Extract<CliStatus, { ok: false }>): string {
  switch (status.reason) {
    case "not-found":
      return "Claude CLI not found. Install it, then reload:  npm i -g @anthropic-ai/claude-code";
    case "too-old":
      return `Claude CLI is out of date (${status.detail}).`;
    case "unusable":
      return `Claude CLI found at ${status.path} but did not respond as expected (${status.detail}).`;
  }
}
