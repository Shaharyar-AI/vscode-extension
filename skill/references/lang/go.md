> **cr-track adapter:** map every check below into a finding (severity per
> `references/ruleset.md`) or a learning/praise annotation. Skip anything
> `go vet`/`gofmt`/`staticcheck` already enforces.

# Go review guide

## Error handling
- Ignored error return (`_ = f()` or the result simply not checked) on a call
  that can meaningfully fail.
- Errors wrapped without context (`return err` instead of
  `fmt.Errorf("doing x: %w", err)`) — loses the call-site story for debugging.
- Sentinel errors compared with `==` instead of `errors.Is`, or type-asserted
  instead of `errors.As`, breaking once the error gets wrapped anywhere upstream.

## Concurrency
- Goroutine started with no way to observe its completion or error
  (fire-and-forget where the caller actually needs the result).
- Shared state (map, slice, counter) written from multiple goroutines without a
  mutex or channel — a data race even if it "usually" works.
- `context.Context` not propagated into a call that should be cancellable
  (blocking I/O, long-running loops) — leaks goroutines on caller timeout.
- Closing a channel from a receiver, or from multiple senders (panics: "close
  of closed channel" or "send on closed channel").
- `sync.WaitGroup.Add` called inside the goroutine instead of before `go func()`
  — race between `Add` and `Wait`.

## Resource management
- `defer f.Close()` missing after a successful `os.Open`/`net.Dial`/DB query, or
  present but the returned error from `Close()` silently discarded when it
  actually matters (e.g. flushing a writer).
- Deferring inside a loop (`for { defer f.Close() }`) — accumulates until the
  enclosing function returns, not each iteration.

## Correctness
- Slice aliasing bugs: appending to a sub-slice that shares backing array with
  the original, corrupting data the caller still holds a reference to.
- Loop variable captured by reference in a closure/goroutine inside a `for`
  loop (fixed by Go 1.22 semantics — flag only if the module targets < 1.22).
- Nil pointer dereference on a struct field that's only sometimes populated.

## Interfaces & design
- Interface accepting concrete-type parameters where an interface would allow
  substitution/testing (accept interfaces, return structs).
- Exported function/type with no doc comment (`// Foo does ...`).

## Testing
- New exported function/branch with no table-driven test case covering it.
- Test that doesn't call `t.Parallel()` where independence would be safe AND
  the package's other tests already do, for consistency — flag only as a
  suggestion/nit, never blocking.
