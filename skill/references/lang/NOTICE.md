# Language guides — scope note

These guides are **authored for CR-Track**, not a verbatim port of any external
repository. An earlier design considered vendoring the language guides from
`awesome-skills/code-review-skill` (MIT) directly; that project's guides were not
reliably fetchable as raw, verbatim files from this environment, and copying content
without being able to verify it byte-for-byte against the real source risked
misattributing content that wasn't actually vendored. Rather than fabricate a
"vendored" guide, each file here is original review guidance written directly for
CR-Track's finding schema and severity model.

**Current coverage:** `javascript.md`, `typescript.md`, `python.md`, `go.md`, plus
`cross-cutting/architecture.md`, `cross-cutting/security.md`,
`cross-cutting/performance.md`.

**Follow-up:** broaden coverage (Rust, Java, C#, Ruby, PHP, Swift, Kotlin, C/C++,
and framework-specific guides for React/Vue/Angular/Svelte/Django/Spring/Rails) —
either author more guides in this same style, or, if a reliable raw-file fetch
becomes available, vendor from a suitable MIT/Apache-licensed source with proper
per-file attribution in this NOTICE.

## Format

Each guide is a flat list of concrete things to check for that language, grouped
loosely by theme. cr-track maps every finding from these checks into its own
category (security/correctness/performance/maintainability/testing/style/docs)
and severity (blocking/important/nit/suggestion) per `references/ruleset.md` —
guides describe WHAT to look for, not the finding schema itself.
