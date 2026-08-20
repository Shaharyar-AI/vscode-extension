/**
 * Child-process helpers.
 *
 * Windows notes that matter here:
 *  - `claude` resolves to `claude.cmd`, and Node cannot exec a .cmd directly
 *    without going through cmd.exe. We detect that and wrap it.
 *  - A command line is capped around 32,000 characters, which a moderate diff
 *    will exceed. Everything large goes in on stdin, never argv.
 */

import { spawn, SpawnOptions } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Called with the spawned process so callers can cancel it. */
  onSpawn?: (kill: () => void) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const isWindows = process.platform === "win32";

/**
 * Every child we have spawned and not yet reaped.
 *
 * Windows has no process groups and `SIGTERM` is advisory there, so a killed
 * `claude.cmd` leaves its node children running. Those orphans accumulate,
 * hold file handles, and are why an uninstall can fail to remove the extension
 * directory. Tracking them is the only way to guarantee they go.
 */
const live = new Set<import("node:child_process").ChildProcess>();

/** Kill a process and everything it started. */
function killTree(child: import("node:child_process").ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    try {
      // /T takes the children with it, /F does not ask nicely.
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return;
    } catch {
      // fall through to the portable path
    }
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 2_000).unref();
  } catch {
    /* already gone */
  }
}

/**
 * Terminate every child still running. Called on deactivate so closing the
 * window never leaves a review process behind.
 */
export function killAllChildren(): number {
  const n = live.size;
  for (const child of live) killTree(child);
  live.clear();
  return n;
}

/** True for executables Windows can only run through the shell. */
function needsShell(command: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(command);
}

export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let cmd = command;
    let argv = args;
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };

    if (needsShell(command)) {
      // cmd.exe /d /s /c "<command>" <args...>  — /s + quoting keeps paths with
      // spaces intact. windowsVerbatimArguments stops Node re-quoting them.
      cmd = process.env.COMSPEC ?? "cmd.exe";
      argv = ["/d", "/s", "/c", `"${command}" ${args.map(quoteWin).join(" ")}`];
      spawnOpts.windowsVerbatimArguments = true;
    }

    const child = spawn(cmd, argv, spawnOpts);
    live.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;

    opts.onSpawn?.(() => killTree(child));

    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

    child.on("error", (err) => {
      live.delete(child);
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      live.delete(child);
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {
        /* child exited before reading stdin — the close handler reports it */
      });
      child.stdin?.end(opts.stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

function quoteWin(arg: string): string {
  return /[\s"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Convenience: run and throw on a non-zero exit. */
export async function runOrThrow(
  command: string,
  args: string[],
  opts: RunOptions = {},
): Promise<string> {
  const r = await run(command, args, opts);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(0, 3).join(" | ");
    throw new Error(`\`${command} ${args.join(" ")}\` exited ${r.code}: ${detail}`);
  }
  return r.stdout;
}
