> **cr-track adapter:** always loaded (per SKILL.md Phase 2.5). Complements the
> `performance` category in `references/ruleset.md`.

# Performance review guide (cross-cutting)

## Database / query patterns
- N+1 queries: a loop that issues one query per item instead of a single
  batched/joined query.
- Missing pagination on a query that can return an unbounded result set.
- A new query added to a hot path (request handler, tight loop) with no
  index backing its filter/sort columns, where that's knowable from the schema.

## Resource lifecycle
- Unclosed streams, file handles, DB connections, or network sockets on any
  exit path (including error paths) — see the language guide for the specific
  idiom (`defer`, `with`, `try/finally`, `using`).
- Connections/clients created per-call instead of reused/pooled where the
  underlying library supports pooling.

## Hot-path cost
- New synchronous/blocking work (network call, disk I/O, heavy computation)
  added inside a loop or a frequently-invoked function, where it could be
  batched, cached, or moved outside the loop.
- Repeated work that could be memoized/cached within a single request or
  process lifetime (recomputing the same derived value multiple times).
- Unbounded allocation in a loop (building a huge in-memory collection instead
  of streaming/processing incrementally) where the input size isn't bounded.

## Concurrency-adjacent
- Serial `await`/blocking calls where the operations are independent and could
  run concurrently (see the language guide's async section for the idiom).
- A cache with no eviction/size bound, growing unbounded over the process
  lifetime.

## Scale sensitivity
- Any change whose cost scales with something that grows without an obvious
  cap (number of users, number of rows, size of a request body) — flag even if
  it "works fine" at current scale, at `nit`/`suggestion` severity unless the
  growth is clearly imminent.
