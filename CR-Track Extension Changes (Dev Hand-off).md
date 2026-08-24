# CR-Track VS Code Extension — Changes (Dev Hand-off)

**Version:** 1.0 · **Date:** 2026-08-21 · **For:** the CR-Track extension author
**From:** Growth & KPI Platform team

**One-line ask:** push the report a **second time** once the developer has finished acting on the findings, and set `finalized: true` on that push. Everything else below is optional polish.

> **Nothing is currently broken.** The platform now reads your existing schema-2.0 payload as-is — verified against a real `.cr-track/last-review.json`. The one change that actually matters is (1); the rest are enhancements.

---

## 1. Why the re-push is required — the whole KPI depends on it

The code-quality KPI is the Growth Plan's target: **≥90% of high-severity findings fixed pre-merge**, computed as `applied ÷ total` over `blocking` + `important` findings.

Your current payload looks like this at push time:

```jsonc
"summary": { "findingsTotal": 3, "applied": 0, "dismissed": 0, "outstanding": 3 }
// every finding: "status": "proposed"
```

That is correct behaviour — you push when the **review** completes, before the developer has approved or applied anything. But it means that if we scored it, **every developer would read 0%**, because at push time nobody has fixed anything yet. The number would be meaningless and would drag a 15%-weighted KPI to the floor for the whole org.

**Two ways to fix it. Either works — pick whichever fits the extension's flow:**

**Option A (preferred) — push once, after the apply pass.** Hold the report until the approve→apply phase finishes, then push with final statuses.

**Option B — push twice.** Push at review time as you do now, then push the **same report again** with the same `review.id` once statuses settle. `POST /api/ingest` is idempotent on `review.id`: the second push overwrites the first in place. No new endpoint, no delete call.

**Either way, set the flag:**

```jsonc
{ "schemaVersion": "2.1", "finalized": true, ... }
```

### What happens without the flag

We infer it, so you are not blocked on shipping this: a report counts as settled once **at least one finding is `applied` or `dismissed`**. An all-`proposed` report is treated as in-flight and held out of the KPI.

That inference has one honest failure: a developer who genuinely fixed **nothing** looks identical to one who hasn't acted yet, so they are not scored rather than scored 0%. That is the safe direction, but it means **a dev who ignores every finding is invisible until you send the flag.** Sending `finalized` explicitly closes that hole.

---

## 2. Keep finding ids stable across the two pushes

For the re-push to update statuses in place rather than replace them, `findings[].id` must mean the same finding in both pushes. `f1`, `f2`, `f3` are fine **as long as** the same finding keeps the same number. If the ids are regenerated from a fresh review pass, the second push replaces the finding set wholesale — which still scores correctly, but the history of what was raised and then fixed is lost.

We store `(review.id, finding.id)` as the identity.

---

## 3. What we already read from your current payload

No change needed on any of these — we adapted to your field names:

| Your field | Used for |
|---|---|
| `repository.remote` | **The repo's identity.** Normalized to `github.com/owner/repo` |
| `repository.host` / `owner` / `repo` | Fallback identity when `remote` is absent — composes the identical slug |
| `repository.name` | The display label (CTO can rename; a later push won't overwrite it) |
| `repository.branch`, `baseBranch` | Shown on the review log |
| `review.id` | Idempotency key |
| `review.completedAt` / `triggeredAt` | Places the review in a cycle |
| `review.commit.sha` / `message` | Shown on the review log |
| `diffStats.filesChanged` / `linesAdded` / `linesRemoved` | Change size — so a percentage has a denominator you can judge |
| `findings[].id` | Finding identity |
| `findings[].severity` | Scored: `blocking` + `important` only. Legacy `critical`/`warning`/`info` are mapped |
| `findings[].status` | `applied` scores; `dismissed` and `proposed` do not |
| `findings[].dismissReason` | Shown to the CTO |
| `findings[].lineStart` | Location (we also accept `line`) |
| `findings[].file`, `title`, `description`, `suggestion`, `category`, `confidence` | The review log |
| `developer.name` / `email` | **Reference only** — identity comes from the ingest token, never from git config |

**Grouping is by repository, not by project.** We do not attempt to map a repo to an Owesome project: "Speak UP" the project, "ai phycology bot" the board and "speakup-ai chat bot next js" the repo share no common token, so any mapping would be hand-kept and would rot. The repo is the unit the developer actually sees.

---

## 4. Optional additions (nice to have, not blocking)

**`annotations[]` — the learning/praise notes.** Your ruleset defines them, but the reviewer's hard rules say *"Return findings ONLY"*, so the model never emits them and the array is absent from the payload. We have a column waiting for it. Praise is worth showing a developer on their own page, and it costs you one array. See §5 for the prompt change that makes the model produce them.

**`finalized`** — see §1.

**A dismissal reason.** You already send `dismissReason: null`. When a developer dismisses a **blocking** or **important** finding, prompting them for one line of justification is worth it: a dismissed high-severity finding counts against the score exactly like an unfixed one (dismissal must not be a free way to clear a blocker), and the CTO board shows dismissals as their own column. A reason is the difference between "the reviewer was wrong" and "I couldn't be bothered".

---

## 5. Prompt changes

Two changes to the system prompt. Both are in the **Hard rules** section; the guides and ruleset are unchanged.

### 5a. Resolve the findings-vs-annotations contradiction

The hard rules currently say:

> - Return findings ONLY. You do not assign ids, statuses, or any envelope
>   metadata; the caller owns all of that.

…while the ruleset says annotations "are produced during the same review pass". The model obeys the hard rule and emits no annotations. **Replace that bullet with:**

```
- Return findings and annotations ONLY. You do not assign ids, statuses, or any
  envelope metadata; the caller owns all of that.
- Annotations are the report-only notes defined in the rule set (`learning` and
  `praise`). They are never fixes, are never approved or applied, and belong in
  a separate `annotations` array — not among the findings. Emitting none is
  fine; emitting praise for genuinely good work is encouraged, and one or two
  per review is plenty.
```

(The `--json-schema` file needs the matching `annotations` array, or the model has nowhere to put them.)

### 5b. Bound how much source the review quotes

`description` and `suggestion` leave the developer's machine and land in our database, where the CTO can read them. The existing secret rule covers credentials but not ordinary proprietary code. **Add after the secrets bullet:**

```
- Quote only what is needed to make the point — a line or two, not a whole
  function. The reader has the repository; they do not need the code repeated
  back to them. Never reproduce customer data, personal data, or credentials
  found in the code, even as an illustration of the problem.
```

We enforce the read side too: quoted code is shown only to the developer who wrote it and to the CTO. A team lead sees the finding's title, file, severity and outcome, but not the code.

---

## 6. Endpoint contract (unchanged)

```
POST https://ikonictracker.demosites.cc/api/ingest
Authorization: Bearer <the developer's CR_TRACK_INGEST_TOKEN>
Content-Type: application/json
```

| Response | Meaning |
|---|---|
| `200 {"ok":true,"reviewId":"...","repo":"github.com/owner/repo"}` | Stored. `repo` echoes the bucket it landed in — useful when debugging a setup |
| `401` | Unknown or revoked token |
| `422 {"error":"invalid payload","details":[...]}` | Failed validation; `details` says what |

Required: `schemaVersion` starting `2.`, `review.id`, and `findings` as an array. Everything else is optional.

The token is minted by the CTO in **Admin → Ingest tokens** and identifies the **real employee** — the git persona in the commit is ignored on purpose.

---

## 7. Where this shows up

- **`/code-quality`** — each developer's own, a card per repo with fixed / open / dismissed.
- **`/code-quality/<repo>`** — the review log for that repo: every push, its findings, and what happened to each.
- **Admin → Code quality** — the org roster with the scored number per developer.

A score is only written once a developer has **5+ high-severity findings** in the cycle; below that the KPI is left unmeasured rather than written from too little signal.
