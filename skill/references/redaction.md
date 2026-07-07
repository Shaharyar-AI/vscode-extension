# CR-Track redaction (security-critical)

The report MUST contain only metadata. Before writing/sending, scan EVERY string
field you generated (titles, descriptions, suggestions, change summaries, AND
every `annotations[].title`/`annotations[].description`) AND the metadata strings
(`review.commit.message`, `repository.host/owner/repo`, `project.*`, and every
`diffStats.files[].path`) and:

> `review.commit.message` is the commit SUBJECT line only — never the body — and is
> still scanned for secrets below like any other string.


1. NEVER include: full file contents, raw diffs/hunks, or any value matching a
   secret pattern below. If a finding's natural description would quote a secret
   or a code block, replace the sensitive substring with `[REDACTED]`.
2. Secret patterns to redact (case-insensitive where sensible):
   - Private keys: `-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----`
   - AWS access key id: `AKIA[0-9A-Z]{16}`
   - GitHub tokens: `gh[pousr]_[0-9A-Za-z]{30,}`
   - Slack tokens: `xox[baprs]-[0-9A-Za-z-]{10,}`
   - Google API keys: `AIza[0-9A-Za-z_-]{35}`
   - Stripe keys: `sk_(live|test)_[0-9A-Za-z]{16,}`
   - JWT: `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
   - Generic assignment: `(?i)(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{6,}`
   - High-entropy / long tokens: any standalone token ≥ 24 chars that is hex
     (`[0-9a-fA-F]{24,}` — INCLUDING all-lowercase hex such as an MD5/SHA hash) or
     base64/base64url (`[A-Za-z0-9+/_-]{24,}`) → redact. Do NOT require mixed case
     or digits; an all-lowercase or all-hex token of this length still qualifies.
3. The `findings` you report about a planted secret are fine to KEEP (e.g. a
   `security` finding "hardcoded secret in src/config.js") — just never echo the
   secret VALUE itself; the title/description must reference the location, not the value.

If in doubt, redact.
