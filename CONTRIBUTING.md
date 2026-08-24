# Writing code that comes back clean

CR-Track reviews every commit and records the result. This is what it looks for,
so you can get ahead of it rather than find out afterwards.

**This file is read by the reviewer.** CR-Track loads `CLAUDE.md` and
`CONTRIBUTING.md` from the repository root into its prompt, so anything written
here becomes part of how your code is judged. That makes it worth keeping
accurate — and worth *not* using to argue findings away. A file that says "don't
report missing tests" produces a clean dashboard and a codebase nobody checked.
The point is to write code that has nothing to report.

---

## What "clean" means

A review returns findings in four severities. Only the top two matter for
whether a commit reads as clean:

| Severity | Meaning |
|---|---|
| **blocking** | Security holes, data loss, crashes, correctness bugs that will reach production |
| **important** | Likely bugs, risky patterns, missing error handling, performance hazards |
| nit | Naming, minor maintainability, documentation |
| suggestion | Optional improvement, safe to skip |

**An empty findings array is a normal, expected outcome.** The reviewer is told
not to invent problems to look thorough, and not to raise anything a linter
would catch. If it reports nothing, that is a real result, not a failure to try.

---

## The seven things it checks

### security
Injection (SQL, command, template), secrets committed in code, weak crypto,
missing authn/authz, unsafe deserialization, SSRF and path traversal.

Never build a query by concatenating input. Parameterise it. Never commit a
credential, not even a test one — and if you find one already committed,
rotating it matters more than deleting the line.

### correctness
Null and undefined dereferences, off-by-one errors, unhandled error and
rejection paths, races on shared state, inverted conditionals, missing imports.

The most common real finding in this repository is a **dereference that happens
before the check guarding it**. Read your own guard clauses in order: if line 3
tolerates a missing value, line 5 cannot assume it exists.

### performance
Unclosed resources (streams, handles, connections), N+1 queries, avoidable work
in hot paths, unbounded loops and allocations.

Anything you open, close on every path — including the error path.

### maintainability
High complexity, duplication, dead code, unclear naming, oversized functions,
leaky abstractions, magic numbers.

### testing
Missing or thin tests for changed logic, untested error paths, uncovered edge
cases.

**A test that cannot fail is worse than no test.** If your assertion would still
pass when the feature is deleted, it is not testing anything — it is recording
that the code ran. Delete the feature locally and confirm the test goes red.

### style
Lint and format violations, deviations from the conventions in this file.

### docs
Missing or stale documentation on public APIs. Stale is worse than missing: a
comment describing behaviour the code no longer has will mislead someone.

---

## Before you commit

Six questions. They map to what actually gets reported, in the order it gets
reported.

1. **Does every value I dereference exist by that line?** Re-read your guards in
   sequence, not as a set.
2. **Does every path that can fail have a handler?** Including the one you think
   cannot happen. Especially an `async` function whose rejection nothing awaits.
3. **Does everything I opened get closed on every exit?** Success, early return,
   and throw.
4. **Would my new test fail if I broke the thing it tests?** If unsure, break it
   and look.
5. **Is any input reaching a query, a path, or a shell without validation?**
6. **Would a stranger understand why this code exists?** Not what it does — the
   code says that. Why it is here.

---

## Conventions in this repository

Follow these and the `style` category stays quiet.

- **Comments explain why, not what.** The code already says what. A comment
  earns its place by recording a decision, a constraint, or a trap.
- **Prefer a clear name over a comment explaining an unclear one.**
- **Errors carry context.** `throw new Error("failed")` tells the next person
  nothing. Say what failed and what was being attempted.
- **No silent catches.** An empty `catch {}` is a decision to ignore a failure;
  if that is genuinely right, say why in a comment. Otherwise handle it.
- **Match the surrounding code.** Its comment density, naming and idiom are the
  local convention, whatever your own preference.
- **Small, single-purpose commits.** A commit that does one thing gets a review
  about one thing. A commit that does five gets a review you will not read.

---

## What the reviewer will not do

Worth knowing so you do not write around problems that were never problems:

- It does not report formatting, import order, quote style, or trailing
  whitespace — a linter catches those deterministically, so it is told not to.
- It does not review merge commits, documentation, JSON, YAML, lockfiles, or
  generated files.
- It only reads the diff, plus files it chooses to open for context. It cannot
  write, execute, or fetch anything.
- It runs on your machine against your own Claude account. Only the redacted
  report is uploaded.

---

## When you disagree

You will sometimes be right and it will sometimes be wrong. A finding is an
observation, not an instruction — nothing is blocked and nothing is auto-fixed.

Mark it fixed if you dealt with it. Leave it open if you have not. What you
should not do is quietly reword this file so the finding stops appearing: the
dashboard is only worth reading while "clean" means the code was clean.
