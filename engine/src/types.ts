/** Shared types for the CR-Track review engine. */

export type Severity = "blocking" | "important" | "nit" | "suggestion";
export type AnnotationSeverity = "learning" | "praise";
export type Category =
  | "security"
  | "correctness"
  | "performance"
  | "maintainability"
  | "testing"
  | "style"
  | "docs";

export const SEVERITY_ORDER: Severity[] = ["blocking", "important", "nit", "suggestion"];
export const CATEGORIES: Category[] = [
  "security",
  "correctness",
  "performance",
  "maintainability",
  "testing",
  "style",
  "docs",
];

/**
 * A machine-applicable patch for a finding.
 *
 * `oldText` is a staleness guard, not decoration: the file may have been edited
 * between the review and the developer clicking the lightbulb, and applying a
 * patch to shifted lines corrupts the file. If it no longer matches, the fix is
 * refused rather than applied.
 */
export interface FindingFix {
  oldText: string;
  newText: string;
}

/** A finding exactly as the model returns it — no id, no status, no envelope. */
export interface RawFinding {
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  suggestion: string;
  confidence: number;
  /** Present only when the fix is local and the model is confident in it. */
  fix?: FindingFix;
}

export interface RawAnnotation {
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: AnnotationSeverity;
  category: Category;
  title: string;
  description: string;
}

/** What the model is contractually obliged to return. */
export interface ModelResult {
  findings: RawFinding[];
  annotations?: RawAnnotation[];
}

/** A finding after the engine has filtered, sorted and numbered it. */
export interface Finding extends RawFinding {
  id: string;
}

export interface Annotation extends RawAnnotation {
  id: string;
}

export type ChangeType = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  language: string | null;
  linesAdded: number;
  linesRemoved: number;
  changeType: ChangeType;
}

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  files: FileChange[];
}

export interface RepoContext {
  root: string;
  name: string;
  remote: string;
  branch: string;
  baseBranch: string;
  head: string;
  headShort: string;
  isDirty: boolean;
  developerName: string;
  developerEmail: string;
}

export type Scope = "staged" | "all" | "committed";

export interface EngineConfig {
  profile: "chill" | "balanced" | "assertive";
  categoriesEnabled: Category[];
  minSeverity: Severity;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxBudgetUsd: number;
  timeoutMs: number;
  guidesEnabled: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  profile: "balanced",
  categoriesEnabled: [...CATEGORIES],
  minSeverity: "nit",
  model: "claude-opus-5",
  effort: "medium",
  // 0 = no cap. Review quality is the objective here, not spend; a cap only
  // ever truncates a review mid-flight and throws the work away.
  maxBudgetUsd: 0,
  timeoutMs: 180_000,
  guidesEnabled: true,
};

export interface ReviewResult {
  findings: Finding[];
  annotations: Annotation[];
  diffStats: DiffStats;
  repo: RepoContext;
  scope: Scope;
  model: string;
  effort: string;
  durationMs: number;
  guidesLoaded: string[];
  cacheKey: string;
  /** Populated when the model produced output we could not use. */
  error?: string;
}
