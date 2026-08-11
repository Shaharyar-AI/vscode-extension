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

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // SIGTERM is advisory on Windows; make sure it actually dies.
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, opts.timeoutMs)
      : null;

    opts.onSpawn?.(() => child.kill("SIGTERM"));

    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
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
