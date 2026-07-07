> **cr-track adapter:** map every check below into a finding (severity per
> `references/ruleset.md`) or a learning/praise annotation. Skip anything a
> linter/formatter (ruff, black, flake8) already enforces.

# Python review guide

## Correctness
- Mutable default arguments (`def f(x=[])`) — shared across calls, classic bug.
- Bare `except:` (or overly broad `except Exception:`) swallowing errors it
  shouldn't, especially around I/O, parsing, or external calls.
- `is`/`is not` used for value comparison instead of `==`/`!=` (works by
  accident for small ints/interned strings, breaks otherwise).
- Late-binding closures in loops (`[lambda: i for i in range(5)]`) capturing the
  loop variable by reference, not value.
- Off-by-one on `range()` bounds or slice indices.
- Comparing floats with `==` instead of a tolerance (`math.isclose`).

## Resource management
- File handles, DB connections, or locks opened without a `with` block (or
  without a matching `close()`/`release()` on every exit path, including
  exceptions).
- Generators/iterators not exhausted or closed where cleanup matters
  (e.g. a DB cursor wrapped in a generator).

## Async
- Blocking, synchronous calls (`requests.get`, `time.sleep`, CPU-bound work)
  inside an `async def` — blocks the event loop for every other coroutine.
- `asyncio.gather` without `return_exceptions=True` where one failure shouldn't
  cancel sibling tasks, if that's the intended behavior.
- Fire-and-forget `asyncio.create_task()` with no reference kept and no error
  handling — task can be garbage-collected mid-flight or fail silently.

## Security
- String-formatted SQL (`f"SELECT * FROM x WHERE id={id}"`, `%`-formatting,
  `.format()`) instead of parameterized queries.
- `subprocess` calls with `shell=True` and any externally-influenced string.
- `pickle.loads` / `yaml.load` (without `SafeLoader`) on untrusted input.
- Secrets in code (also flag for redaction), especially in config modules
  imported at startup.

## Maintainability
- Deep nesting a guard clause would flatten.
- Type hints present on some functions in a module but not others (creates a
  false sense of consistency) — flag only if the module has otherwise adopted
  typing.
- Overloaded functions doing unrelated things behind a boolean flag parameter.

## Testing
- New branch/exception path with no test exercising it.
- Fixtures that don't actually isolate state between tests (e.g. mutable
  module-level state not reset).
