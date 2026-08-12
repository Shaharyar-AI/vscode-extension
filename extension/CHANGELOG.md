# Changelog

## 0.1.0

First release.

- Reviews staged changes automatically, two seconds after the git index settles,
  so the result is usually ready before you press commit.
- Findings appear as editor squiggles and in a dedicated Findings panel grouped
  by folder and file, with accept and reject on each row.
- Accept applies a patch and is offered only where Claude supplied one. The
  current file is checked against what was reviewed first, so a patch is never
  applied to lines that have moved.
- Reject records a reason, which goes into the report.
- **Review & Commit** asks before committing over a blocking finding and always
  offers a way through.
- Every review writes `.cr-track/last-review.json`, and POSTs it when the
  repository configures an `endpoint`. Secrets are stripped first; a failed
  upload queues and retries and can never interrupt a commit.
- Language guides for TypeScript, JavaScript, Python and Go, plus always-on
  architecture, security and performance guides.
- Missing or outdated Claude CLI parks the extension as dormant with one
  notification rather than failing repeatedly.
