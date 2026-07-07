# CR-Track report payload (schemaVersion 2.0)

Top-level keys: `schemaVersion`, `source`, `ruleset`, `review`, `developer`,
`repository`, `project`, `diffStats`, `findings`, `annotations`, `summary`,
`changes`, `client`.

> **REQUIRED — the dashboard returns HTTP 422 and rejects the report if any of
> these are missing or wrong:**
> - `schemaVersion` === `"1.0"` or `"2.0"` (exact string; use `"2.0"` unless you
>   have a specific reason to emit the legacy `"1.0"` shape)
> - `source` === `"claude-code-skill"` (exact string)
> - `ruleset` is a string (use `"coderabbit-style@2.0"`)
> - `review.id` non-empty string, `review.mode` ∈ {staged,all,committed}
> - `developer.email` contains `@`
> - `repository.remote` is a string (`""` allowed)
> - `findings` is an array; per finding: valid `severity` (see enum below per
>   schemaVersion), `category`/`status`/`detectedBy` enums, and a BOOLEAN `accepted`
> - `annotations` is an array if present (each: `id`, an annotation `severity`
>   ∈ {learning,praise}, `category`) — OPTIONAL, omit if there are none
> - `changes` is an array; `summary` is an object
> Build the FULL object (don't assemble from memory) — use the example below.

All the metadata fields added in v0.4.0 (`repository.host/owner/repo/defaultBranch/
isDirty`, `review.commit`, `project`, `diffStats.files`, `client.os/nodeVersion/ci`)
are **OPTIONAL** and best-effort — omit any the skill couldn't resolve.

**Severity enum depends on `schemaVersion`:**
- `"2.0"` → `findings[].severity` ∈ {blocking, important, nit, suggestion}
- `"1.0"` (legacy) → `findings[].severity` ∈ {critical, warning, info} — no
  `annotations` field in this shape

- `schemaVersion`: "2.0"  | `source`: "claude-code-skill"  | `ruleset`: "coderabbit-style@2.0"
- `review`: { id (uuid), triggeredAt (ISO8601), completedAt (ISO8601),
  status ("completed"), mode ("staged"|"all"|"committed"), durationMs (int),
  secondPass (bool),
  commit?: { sha, shortSha, message, authorName, authorEmail, authoredAt (ISO8601),
             aheadOfBase (int), behindBase (int) } }
- `developer`: { name, email, gitUser }
- `repository`: { name, remote, branch, baseBranch, commitBefore, commitAfter,
  host?, owner?, repo?, defaultBranch?, isDirty? (bool) }
- `project`?: { name, version, primaryLanguage }
- `diffStats`: { filesChanged, linesAdded, linesRemoved,
  files?: array of { path, language, linesAdded, linesRemoved,
                     changeType ("added"|"modified"|"deleted"|"renamed") } }
- `findings`: array of {
    id, file, lineStart, lineEnd, severity (blocking|important|nit|suggestion),
    category, title, description, suggestion, status, accepted (bool),
    dismissReason (string|null), detectedBy ("llm"|"coderabbit-cli") }
- `annotations`?: array of { id, file, lineStart, lineEnd, severity
    (learning|praise), category, title, description } — OPTIONAL, omit if empty.
    Never has `status`/`accepted`/`suggestion` — these are report-only, not findings.
- `summary`: { findingsTotal, bySeverity {blocking,important,nit,suggestion},
    byCategory {...}, annotations? {learning,praise}, accepted, applied,
    dismissed, reviewerTimeSavedMin }
- `changes`: array of { file, findingId, changeType, linesAdded, linesRemoved, summary }
- `client`: { skillVersion: "2.0.0", host, os?, nodeVersion?, ci? (bool) }

Derivations:
- `accepted` = (status ∈ {approved, applied})
- `summary.accepted` = count of findings with accepted = true
- `summary.applied` = count with status = applied
- `summary.dismissed` = count with status = dismissed
- `reviewerTimeSavedMin` = sum over APPLIED findings of
  {blocking:10, important:5, nit:1, suggestion:1} (annotations contribute 0)
- `commitAfter` = current HEAD after edits (same as commitBefore if no commit was made)

## Worked example

```json
{
  "schemaVersion": "2.0",
  "source": "claude-code-skill",
  "ruleset": "coderabbit-style@2.0",
  "review": {
    "id": "0f8e1c2a-...-uuid",
    "triggeredAt": "2026-06-24T09:00:00Z",
    "completedAt": "2026-06-24T09:02:11Z",
    "status": "completed",
    "mode": "staged",
    "durationMs": 131000,
    "secondPass": false,
    "commit": {
      "sha": "a1b2c3d4e5f6...", "shortSha": "a1b2c3d",
      "message": "Add invoice pagination", "authorName": "Asha Khan",
      "authorEmail": "asha@office.com", "authoredAt": "2026-06-24T08:55:00Z",
      "aheadOfBase": 3, "behindBase": 0
    }
  },
  "developer": { "name": "Asha Khan", "email": "asha@office.com", "gitUser": "asha" },
  "repository": {
    "name": "billing-service",
    "remote": "git@github.com:office/billing-service.git",
    "branch": "feature/invoices",
    "baseBranch": "main",
    "commitBefore": "a1b2c3d",
    "commitAfter": "e4f5a6b",
    "host": "github.com", "owner": "office", "repo": "billing-service",
    "defaultBranch": "main", "isDirty": true
  },
  "project": { "name": "billing-service", "version": "2.3.0", "primaryLanguage": "TypeScript" },
  "diffStats": {
    "filesChanged": 4, "linesAdded": 120, "linesRemoved": 30,
    "files": [
      { "path": "src/db.js", "language": "JavaScript", "linesAdded": 3, "linesRemoved": 1, "changeType": "modified" }
    ]
  },
  "findings": [
    {
      "id": "f1",
      "file": "src/db.js",
      "lineStart": 42,
      "lineEnd": 42,
      "severity": "blocking",
      "category": "security",
      "title": "SQL injection via string concatenation",
      "description": "User input is concatenated into the query string.",
      "suggestion": "Use a parameterized query / prepared statement.",
      "status": "applied",
      "accepted": true,
      "dismissReason": null,
      "detectedBy": "llm"
    }
  ],
  "annotations": [
    {
      "id": "a1",
      "file": "src/util.js",
      "lineStart": 1,
      "lineEnd": 1,
      "severity": "praise",
      "category": "maintainability",
      "title": "Nice, thorough test coverage on the edge cases here",
      "description": null
    }
  ],
  "summary": {
    "findingsTotal": 7,
    "bySeverity": { "blocking": 1, "important": 3, "nit": 2, "suggestion": 1 },
    "byCategory": { "security": 2, "correctness": 2, "performance": 1, "maintainability": 1, "docs": 1 },
    "annotations": { "learning": 0, "praise": 1 },
    "accepted": 5,
    "applied": 5,
    "dismissed": 2,
    "reviewerTimeSavedMin": 25
  },
  "changes": [
    {
      "file": "src/db.js",
      "findingId": "f1",
      "changeType": "edit",
      "linesAdded": 3,
      "linesRemoved": 1,
      "summary": "Fixed [Security] SQL injection via string concatenation — replaced string concatenation with a parameterized query."
    }
  ],
  "client": { "skillVersion": "2.0.0", "host": "asha-mbp", "os": "darwin", "nodeVersion": "v20.11.0", "ci": false }
}
```

> Note: `reviewerTimeSavedMin` above is illustrative (copied from the PRD example).
> Per the formula it equals the per-severity sum over the **applied** findings only
> (blocking 10 / important 5 / nit 1 / suggestion 1) — compute it from your actual
> applied set rather than reproducing this number.
