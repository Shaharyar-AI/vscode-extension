> **cr-track adapter:** always loaded (per SKILL.md Phase 2.5). Complements the
> `security` category in `references/ruleset.md` and any language guide's own
> security section — this file is the language-agnostic checklist.

# Security review guide (cross-cutting)

## Injection
- Any user-influenced string concatenated into a query, shell command,
  template, XML/XPath expression, or LDAP filter instead of using a
  parameterized/escaped API.
- Deserializing untrusted input with a format/library that can execute code
  (native pickle-style deserializers, unsafe YAML loaders, `eval`-based parsers).

## AuthN/AuthZ
- An endpoint/handler that performs an action but never checks the caller is
  authorized for THAT specific resource (checks "is logged in" but not
  "owns this record" — an IDOR risk).
- Authorization check present but performed AFTER a side effect that already
  happened (log written, resource allocated, external call made).
- Sensitive routes/operations missing from an existing authz middleware list
  that other similar routes are registered under.

## Secrets & sensitive data
- Hardcoded API keys, passwords, tokens, or private keys in source, config
  checked into the repo, or committed test fixtures.
- Sensitive values (tokens, passwords, PII) logged in plaintext.
- Secrets passed via command-line arguments (visible in process listings)
  instead of environment variables or a secrets manager.

## Transport & storage
- New network calls over plain HTTP where HTTPS is available/expected.
- Sensitive data written to disk/cache without considering whether it needs
  encryption at rest, given what else touches that storage.

## Input validation
- Trusting a value's type/shape from an external source without validating it
  matches what the code assumes (missing schema validation on request bodies).
- Path values built from user input without normalizing/checking for
  traversal (`../`) before use in file operations.

## Weak crypto
- Deprecated/broken primitives (MD5, SHA1, DES) used for anything
  security-relevant (not just checksums where collision resistance doesn't
  matter).
- Hand-rolled crypto/random instead of the platform's vetted primitives
  (especially for tokens, session IDs, password hashing — these need a
  purpose-built KDF like bcrypt/scrypt/argon2, not a fast general hash).
