> **cr-track adapter:** map every check below into a finding (severity per
> `references/ruleset.md`) or a learning/praise annotation. Everything in
> `javascript.md` applies too — this file is TypeScript-specific additions.

# TypeScript review guide

## Type safety
- `any` introduced where a real type (or `unknown` + narrowing) was available —
  especially on function parameters/return types at a public boundary.
- Type assertions (`as T`, `!`) that suppress a real type error rather than fix
  the underlying mismatch; `as unknown as T` double-casts are a strong signal.
- Widened return types (`string | undefined` silently narrowed with `!`) instead
  of handling the `undefined` case.
- Optional chaining (`?.`) papering over a value that should never be
  null/undefined by design — masks a bug upstream instead of surfacing it.
- Enums vs. union-of-string-literals: flag inconsistency within one codebase,
  not one over the other.
- Missing discriminated-union narrowing — a `switch` on a tagged union without
  an `exhaustive: never` default case, so a new variant silently falls through.

## Correctness
- Non-null assertions (`!`) on a value from an external source (API response,
  DB row, `Array.prototype.find`) — these NEED a real null-check.
- Structural typing surprises: an object satisfies an interface but is missing
  a field only used conditionally (won't be caught until runtime).
- Async function typed to return `Promise<T>` but a code path returns a bare
  value or `undefined` without wrapping.

## Maintainability
- Overly broad utility types (`Partial<T>` on something that should require
  most fields) that push validation responsibility onto every call site.
- Barrel-file (`index.ts`) re-exports that create circular import risk.
- Interface/type duplicated instead of derived (`Pick`/`Omit`/`ReturnType`) from
  an existing type — drift risk when the source type changes.

## Testing
- Type-only changes (interface/type edits) with no corresponding runtime test
  update, when the type change reflects a real behavior change.
