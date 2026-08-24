# HELPING.md — house rules for writing code that passes review

Drop this file into any project you start. It tells an AI assistant — and any
human reading it — how to write code that comes back clean from review.

**To make it work automatically, copy it to the project root as `CLAUDE.md`.**
Claude Code reads `CLAUDE.md` before writing anything, and CR-Track reads it into
the review prompt. One file, so the code is written and judged against the same
standard.

```bash
cp HELPING.md /path/to/new-project/CLAUDE.md
```

Everything below is written as instructions to whoever is producing the code.

---

## Non-negotiable

These are the things that get a commit marked **blocking**. Nothing else in this
file matters as much.

- **Never concatenate input into a query, command, path, or template.**
  Parameterise. This is the single most common serious finding.
- **Never commit a credential** — not a real one, not a test one, not a
  placeholder that looks real. If one is already committed, rotating it matters
  more than deleting the line.
- **Validate anything that crosses a boundary** before it reaches a database, a
  filesystem path, a shell, or another service.
- **Check authorisation on every path that needs it**, not just the first one.
  A second endpoint added later is where this breaks.

## Correctness

- **Read your guard clauses in order.** If line 3 tolerates a value being
  missing, line 5 cannot assume it exists. Dereferencing before the check that
  guards it is the most frequent real bug found in review.
- **Handle the error path you think cannot happen.** Especially an `async`
  function whose rejection nothing awaits — that terminates the process in Node
  and vanishes silently in a browser.
- **Never write an empty `catch {}`.** If ignoring the failure is genuinely
  right, write one line saying why. Otherwise handle it.
- **Errors must carry context.** `throw new Error("failed")` tells the next
  person nothing. Say what failed and what was being attempted.
- **Off-by-one:** prefer `<` over `<=` against a length, and iterate collections
  directly rather than by index where the language allows it.

## Resources and cost

- **Close what you open on every exit** — success, early return, and throw. Use
  the language's scoped construct (`try/finally`, `with`, `defer`, `using`).
- **No queries inside loops.** Fetch the set once. An N+1 query is invisible on
  ten rows and fatal on ten thousand.
- **Bound anything unbounded.** A loop over user input, an accumulating array, a
  cache with no eviction — each is fine until it is not.
- **Do not optimise what you have not measured**, but do not write something
  obviously quadratic in a hot path either.

## Tests that mean something

- **A test that cannot fail is worse than no test.** It records that the code
  ran, and it makes the dashboard lie.
- **Prove it:** break the thing on purpose and confirm the test goes red. If it
  stays green, the test is not testing anything. Then put it back.
- **Test the error paths**, not just the happy one. Untested error handling is
  where production surprises live.
- **Assert on the observable outcome**, not on internals the implementation
  happens to have. A test coupled to internals fails on every refactor and
  catches no bugs.
- **Name the test for the behaviour it protects**, so a failure tells you what
  broke without reading the body.

## Naming and comments

- **Comments explain why, not what.** The code already says what. A comment
  earns its place by recording a decision, a constraint, or a trap someone will
  otherwise fall into.
- **A clear name beats a comment explaining an unclear one.** Rename first.
- **Stale comments are worse than missing ones.** If you change behaviour,
  change the comment describing it — or delete it.
- **Match the surrounding code.** Its naming, its comment density, its idiom are
  the local convention, whatever your own preference is.

## Shape

- **Small, single-purpose functions.** If you cannot name it without "and", it
  is doing two things.
- **Delete dead code rather than commenting it out.** Version control remembers.
- **No magic numbers.** Name the constant, and the name explains the number.
- **Do not add abstraction for a second case that does not exist yet.** Two
  concrete implementations are easier to merge later than one wrong abstraction
  is to unpick.

## Commits

- **One commit, one thing.** A commit that does one thing gets a review about
  one thing; a commit that does five gets a review nobody reads.
- **Say why in the message, not what.** The diff shows what changed. The message
  should say what problem it solves.
- **Do not mix a refactor with a behaviour change.** If both are needed, that is
  two commits, and the review of each is worth having.

---

## Before you say it is finished

Six questions. Answer them honestly against the code you just wrote.

1. Does every value I dereference exist by the line that uses it?
2. Does every path that can fail have a handler, including the unlikely one?
3. Is everything I opened closed on every exit, including the error exit?
4. Would my new test fail if I broke the thing it tests?
5. Does any input reach a query, path, or shell without validation?
6. Would a stranger understand *why* this code exists, not just what it does?

If the answer to any of them is "probably", it is a no. Go and check.

---

## What review will not complain about

Knowing this stops you writing around problems that are not problems:

- Formatting, import order, quote style, trailing whitespace — a linter catches
  those deterministically, and the reviewer is told to ignore them.
- Merge commits, documentation, JSON, YAML, lockfiles and generated files are
  not reviewed at all.
- An empty findings list is a normal outcome. The reviewer is instructed not to
  invent problems to look thorough.

## One warning about this file

Because the reviewer reads it, this file can be used to make findings disappear
without fixing anything. Adding "do not report missing tests" would produce a
clean dashboard over a codebase nobody checked.

Keep it describing how you actually intend to work. "Clean" is only worth
reading while it means the code was clean.
