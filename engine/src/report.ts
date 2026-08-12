/**
 * Report assembly.
 *
 * Entirely deterministic. The model contributes findings and nothing else — no
 * envelope, no metadata, no decision about whether to send. That is what makes
 * the report trustworthy and the upload a non-event.
 */

import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import { primaryLanguage } from "./languages";
import { redactDeep } from "./redact";
import type {
  Annotation,
  Category,
  DiffStats,
  Finding,
  RepoContext,
  Scope,
  Severity,
} from "./types";

export type FindingStatus = "proposed" | "applied" | "dismissed";

export interface FindingOutcome {
  status: FindingStatus;
  reason?: string;
}

export interface ReportInput {
  repo: RepoContext;
  stats: DiffStats;
  findings: Finding[];
  annotations: Annotation[];
  outcomes: ReadonlyMap<string, FindingOutcome>;
  scope: Scope;
  model: string;
  effort: string;
  durationMs: number;
  triggeredAt: Date;
  completedAt: Date;
  overrideReason?: string;
  extensionVersion: string;
  cliVersion?: string;
}

/**
 * The dashboard validates `source` against an exact string and has done since
 * the skill predated this extension. Renaming it here would 422 every report,
 * so the wire value stays put and `client.surface` carries what actually
 * produced it.
 */
export const SOURCE = "claude-code-skill";

/** One applied fix, as the dashboard's `changes[]` expects it. */
export interface ChangeRecord {
  file: string;
  findingId: string;
  changeType: "edit";
  linesAdded: number;
  linesRemoved: number;
  summary: string;
}

export interface Report {
  schemaVersion: "2.0";
  source: typeof SOURCE;
  ruleset: string;
  review: Record<string, unknown>;
  developer: Record<string, unknown>;
  repository: Record<string, unknown>;
  project?: Record<string, unknown>;
  diffStats: DiffStats;
  findings: Record<string, unknown>[];
  annotations?: Record<string, unknown>[];
  changes: ChangeRecord[];
  summary: Record<string, unknown>;
  client: Record<string, unknown>;
}

/** Minutes of review time each applied finding is treated as saving. */
const TIME_SAVED: Record<Severity, number> = {
  blocking: 10,
  important: 5,
  nit: 1,
  suggestion: 1,
};

export function buildReport(input: ReportInput): { report: Report; redactionHits: string[] } {
  const { repo, stats, findings, annotations, outcomes } = input;

  const decorated = findings.map((f) => {
    const outcome = outcomes.get(f.id);
    const status: FindingStatus = outcome?.status ?? "proposed";
    return {
      id: f.id,
      file: f.file,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      severity: f.severity,
      category: f.category,
      title: f.title,
      description: f.description,
      suggestion: f.suggestion,
      confidence: f.confidence,
      hadPatch: Boolean(f.fix),
      status,
      accepted: status === "applied",
      dismissReason: outcome?.reason ?? null,
      detectedBy: "llm" as const,
    };
  });

  const bySeverity: Record<Severity, number> = { blocking: 0, important: 0, nit: 0, suggestion: 0 };
  const byCategory: Partial<Record<Category, number>> = {};
  for (const f of findings) {
    if (f.severity in bySeverity) bySeverity[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }

  const applied = decorated.filter((f) => f.status === "applied");
  const dismissed = decorated.filter((f) => f.status === "dismissed");

  // One record per fix actually written to a file. The summary is deliberately
  // self-contained — it has to read correctly in a dashboard row with no
  // access to the finding it came from.
  const changes: ChangeRecord[] = applied.map((f) => {
    const source = findings.find((x) => x.id === f.id);
    const fix = source?.fix;
    return {
      file: f.file,
      findingId: f.id,
      changeType: "edit",
      linesAdded: fix ? fix.newText.split("\n").length : 0,
      linesRemoved: fix ? fix.oldText.split("\n").length : 0,
      summary: `Fixed [${f.category}] ${f.title} — ${f.suggestion}`,
    };
  });

  const report: Report = {
    schemaVersion: "2.0",
    source: SOURCE,
    ruleset: "coderabbit-style@2.0",
    review: {
      id: randomUUID(),
      triggeredAt: input.triggeredAt.toISOString(),
      completedAt: input.completedAt.toISOString(),
      durationMs: input.durationMs,
      status: "completed",
      mode: input.scope,
      model: input.model,
      effort: input.effort,
      secondPass: false,
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
    },
    developer: {
      name: repo.developerName,
      email: repo.developerEmail,
      gitUser: repo.developerEmail.split("@")[0] || repo.developerName,
    },
    repository: {
      name: repo.name,
      remote: repo.remote,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      commitBefore: repo.headShort,
      isDirty: repo.isDirty,
      ...parseRemote(repo.remote),
    },
    ...(primaryLanguage(stats.files.map((f) => f.path))
      ? { project: { primaryLanguage: primaryLanguage(stats.files.map((f) => f.path)) } }
      : {}),
    diffStats: stats,
    findings: decorated,
    ...(annotations.length
      ? {
          annotations: annotations.map((a) => ({
            id: a.id,
            file: a.file,
            lineStart: a.lineStart,
            lineEnd: a.lineEnd,
            severity: a.severity,
            category: a.category,
            title: a.title,
            description: a.description,
          })),
        }
      : {}),
    changes,
    summary: {
      findingsTotal: findings.length,
      bySeverity,
      byCategory,
      applied: applied.length,
      dismissed: dismissed.length,
      outstanding: decorated.length - applied.length - dismissed.length,
      patchesOffered: decorated.filter((f) => f.hadPatch).length,
      reviewerTimeSavedMin: applied.reduce((n, f) => n + (TIME_SAVED[f.severity] ?? 0), 0),
      ...(annotations.length
        ? {
            annotations: {
              learning: annotations.filter((a) => a.severity === "learning").length,
              praise: annotations.filter((a) => a.severity === "praise").length,
            },
          }
        : {}),
    },
    client: {
      surface: "vscode-extension",
      extensionVersion: input.extensionVersion,
      cliVersion: input.cliVersion ?? null,
      host: safeHostname(),
      os: platform(),
      nodeVersion: process.version,
      ci: Boolean(process.env["CI"]),
    },
  };

  // Redaction runs last, over everything, including anything the model wrote.
  const { value, hits } = redactDeep(report);
  return { report: value, redactionHits: hits };
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

/** Split a remote URL into host/owner/repo. Handles ssh and https forms. */
function parseRemote(remote: string): Record<string, string> {
  if (!remote) return {};
  const cleaned = remote.replace(/\.git$/, "").replace(/\/+$/, "");
  const ssh = cleaned.match(/^[^@]+@([^:]+):(.+?)\/([^/]+)$/);
  if (ssh?.[1] && ssh[2] && ssh[3]) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
  const https = cleaned.match(/^https?:\/\/([^/]+)\/(.+?)\/([^/]+)$/);
  if (https?.[1] && https[2] && https[3]) return { host: https[1], owner: https[2], repo: https[3] };
  return {};
}
