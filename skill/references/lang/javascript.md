> **cr-track adapter:** map every check below into a finding (severity per
> `references/ruleset.md`) or a learning/praise annotation. Skip anything a
> linter/formatter already enforces per the automation-awareness rule.

# JavaScript review guide

## Correctness
- Unhandled promise rejections: a `.then()` with no `.catch()`, or an `async`
  function called without `await`/`.catch()` in a context where the error is lost.
- Loose equality (`==`/`!=`) where the type coercion isn't clearly intentional.
- `var` in new code (scoping bugs) — should be `let`/`const`.
- Off-by-one in loop bounds, especially with `<=` vs `<` on array indices.
- Mutating a function argument (array/object) when the caller doesn't expect it.
- `NaN` comparisons via `===` instead of `Number.isNaN()`.
- Array holes / sparse arrays from `delete arr[i]` instead of `splice`.
- Callback-style code mixed with promises without a clear boundary (easy to
  double-resolve or drop errors).

## Async & concurrency
- Missing `Promise.all`/`allSettled` where independent async calls run
  sequentially with no ordering dependency (unnecessary latency).
- Race conditions on shared state written from multiple async callbacks/timers.
- `setInterval`/`setTimeout` handles never cleared (leak, especially in
  long-lived processes or repeated component mounts).
- Event listeners added without a matching removal (memory leak in long-lived
  processes; in the browser, on repeated mount/unmount).

## Security
- Building HTML via string concatenation/template literals with unescaped
  user input (`innerHTML`, template strings into `dangerouslySetInnerHTML`).
- `eval`, `new Function(...)`, or `child_process.exec` with any
  externally-influenced string.
- Regexes built from user input (ReDoS risk) or catastrophic-backtracking
  patterns (nested quantifiers like `(a+)+`).
- Secrets/tokens hardcoded as string literals (also flag for redaction).

## Error handling
- `catch (e) {}` (swallowed error, no logging/rethrow/handling).
- Errors thrown as non-Error values (bare strings/objects) — loses stack trace.
- Generic `catch` blocks that mask the specific failure mode a caller needs.

## Maintainability
- Deep nesting (>3 levels) that a guard clause or early return would flatten.
- Duplicated logic across files that could be a shared utility.
- Magic numbers/strings without a named constant, especially repeated ones.
- Functions doing more than one clearly-nameable thing.

## Testing
- New exported function/branch with no corresponding test.
- Tests that mock the exact thing under test (test proves nothing).
- Async test missing `await`/`done()` — can pass even when the assertion fails.
