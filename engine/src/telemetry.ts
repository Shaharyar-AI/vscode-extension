/**
 * Writing and sending reports.
 *
 * Two guarantees, in order of importance:
 *
 *  1. The local file is always written. It is the durable record, and it does
 *     not depend on a network, an endpoint, or a dashboard being up.
 *  2. Nothing here ever throws into the caller. A failed upload is a queued
 *     file and a log line, never an interrupted commit.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "./report";

export interface DeliveryResult {
  localPath: string;
  uploaded: boolean;
  queued: boolean;
  status?: number;
  detail?: string;
  /**
   * Set when the server rejected the report for a reason retrying cannot fix.
   *
   * "auth" is a missing, wrong or revoked token; "payload" is a report the
   * server considers malformed. Both are permanent until someone acts, so
   * neither is queued — a queue full of reports that can never succeed hides
   * the problem instead of surfacing it.
   */
  permanentFailure?: "auth" | "payload";
  /** For a 422, the per-problem list the server sent back. */
  details?: string[];
}

const DIR = ".cr-track";
const QUEUE = "queue";
/** Stop the queue growing without bound if a dashboard stays down for weeks. */
const MAX_QUEUED = 200;

export function reportDir(repoRoot: string): string {
  return join(repoRoot, DIR);
}
function queueDir(repoRoot: string): string {
  return join(repoRoot, DIR, QUEUE);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Write the report locally, then try to send it. Any failure queues it.
 */
export async function deliver(
  repoRoot: string,
  report: Report,
  options: { endpoint?: string; token?: string; timeoutMs?: number } = {},
): Promise<DeliveryResult> {
  const dir = reportDir(repoRoot);
  ensureDir(dir);

  const localPath = join(dir, "last-review.json");
  const body = JSON.stringify(report, null, 2);
  writeFileSync(localPath, body, "utf8");

  if (!options.endpoint) {
    return { localPath, uploaded: false, queued: false, detail: "no endpoint configured" };
  }

  const sent = await post(options.endpoint, body, options.token, options.timeoutMs ?? 15_000);
  if (sent.ok) {
    return { localPath, uploaded: true, queued: false, status: sent.status };
  }

  // 401 and 422 will fail identically however many times they are retried: one
  // needs a new token, the other a different payload. Queueing them buries a
  // problem the developer has to be told about, and fills the queue with work
  // that can never drain.
  const permanent = permanentKind(sent.status);
  if (permanent) {
    return {
      localPath,
      uploaded: false,
      queued: false,
      status: sent.status,
      permanentFailure: permanent,
      ...(sent.details ? { details: sent.details } : {}),
      detail: sent.detail,
    };
  }

  enqueue(repoRoot, report, body);
  return {
    localPath,
    uploaded: false,
    queued: true,
    ...(sent.status !== undefined ? { status: sent.status } : {}),
    detail: sent.detail,
  };
}

/** Retry everything sitting in the queue. Called on startup and after a send. */
export async function flushQueue(
  repoRoot: string,
  options: { endpoint?: string; token?: string; timeoutMs?: number } = {},
): Promise<{ sent: number; remaining: number }> {
  const dir = queueDir(repoRoot);
  if (!options.endpoint || !existsSync(dir)) return { sent: 0, remaining: 0 };

  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let sent = 0;

  for (const name of files) {
    const path = join(dir, name);
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const result = await post(options.endpoint, body, options.token, options.timeoutMs ?? 15_000);
    if (!result.ok) break; // still down — leave the rest for next time
    try {
      rmSync(path);
    } catch {
      /* it will be retried and 409'd or overwritten; not worth failing over */
    }
    sent++;
  }

  const remaining = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).length
    : 0;
  return { sent, remaining };
}

function enqueue(repoRoot: string, report: Report, body: string): void {
  const dir = queueDir(repoRoot);
  ensureDir(dir);

  const id = String((report.review as { id?: string }).id ?? Date.now());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    writeFileSync(join(dir, `${stamp}-${id.slice(0, 8)}.json`), body, "utf8");
  } catch {
    return;
  }

  // Oldest first, so the queue keeps the most recent history when it overflows.
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_QUEUED))) {
      rmSync(join(dir, stale));
    }
  } catch {
    /* pruning is best-effort */
  }
}

/** What a token turned out to be worth. */
export type TokenCheck = "ok" | "unauthorized" | "unreachable";

/**
 * Check a token without leaving anything behind.
 *
 * Deliberately sends a payload the server must reject. Auth is checked before
 * validation, so the status separates the two questions: 422 means the token
 * was accepted and only the body was refused, 401 means the token was not.
 * Sending a *valid* probe would answer the same question by writing a junk
 * review into the dashboard for every developer who ever sets a token.
 */
export async function checkToken(
  endpoint: string,
  token: string,
  timeoutMs = 15_000,
): Promise<TokenCheck> {
  const result = await post(endpoint, "{}", token, timeoutMs);
  if (result.status === 401 || result.status === 403) return "unauthorized";

  // "ok" means the request got past auth and into validation, which only these
  // statuses prove. A 404 from a mistyped path, a 502 from a proxy or a 500
  // never reached the handler at all — reporting those as a working token is
  // the opposite of this check's purpose, which is to say now rather than at
  // the developer's next commit.
  if (result.status === 422 || result.status === 400) return "ok";
  if (result.status !== undefined && result.status >= 200 && result.status < 300) return "ok";
  return "unreachable";
}

interface PostResult {
  ok: boolean;
  status?: number;
  detail?: string;
  details?: string[];
}

function permanentKind(status: number | undefined): "auth" | "payload" | undefined {
  if (status === 401 || status === 403) return "auth";
  if (status === 422 || status === 400) return "payload";
  return undefined;
}

/** Pull the `details` array out of a 422 body, if the server sent one. */
function readDetails(text: string): string[] | undefined {
  try {
    const body = JSON.parse(text) as { details?: unknown };
    if (!Array.isArray(body.details)) return undefined;
    const list = body.details.map((d) => String(d)).filter(Boolean);
    return list.length ? list : undefined;
  } catch {
    return undefined;
  }
}

async function post(
  endpoint: string,
  body: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => "");
    const details = readDetails(text);
    return {
      ok: false,
      status: res.status,
      detail: text.slice(0, 300),
      ...(details ? { details } : {}),
    };
  } catch (err) {
    const message = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message;
    return { ok: false, detail: message };
  } finally {
    clearTimeout(timer);
  }
}
