> **cr-track adapter:** this guide is always loaded (per SKILL.md Phase 2.5) and
> feeds the high-level pass in ruleset.md, run once over the whole change set
> before line-by-line review.

# Architecture review guide

## Fit with existing structure
- New code that duplicates an existing abstraction instead of extending it —
  check for a sibling module/class already solving the same problem.
- A change that crosses a layer boundary it shouldn't (e.g. a data-access
  function importing a UI component, or business logic reaching directly into
  a driver/transport layer that a service layer normally wraps).
- New file placed in a location that breaks the project's existing
  by-responsibility organization (check the surrounding directory's pattern
  before assuming this file's placement is fine).

## Coupling & interfaces
- A new dependency between modules that previously had none, without a clear
  interface boundary — the calling module now needs to know internal details
  of the callee.
- Widening a function/API's parameter or return shape in a way that leaks an
  internal detail (a DB row shape, an internal enum) into a public contract.
- Circular dependencies introduced between modules/packages.

## Test strategy
- A new code path (new branch, new error case, new public function) with no
  corresponding test anywhere in the change set.
- Tests added at the wrong level — an integration-level concern tested only via
  a unit test with everything mocked, or vice versa (a trivial pure function
  tested only through a slow end-to-end path).
- A refactor with no tests changed at all — either the refactor is truly
  behavior-preserving (fine) or the existing tests aren't actually exercising
  the changed code (a gap worth flagging as a `suggestion`/`nit`, not blocking
  unless the risk is real).

## Cross-cutting performance risk
- A change that runs on every request/every item in a hot loop, where the
  per-call cost is now higher than before (a new allocation, a new synchronous
  call) — see `cross-cutting/performance.md` for specifics; flag the
  architectural shape here if it spans multiple files.
