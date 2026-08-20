# CR-Track dashboard

A stand-in dashboard so review data can be seen while the real one is built.

**Live:** https://cr-track-dashboard.vercel.app
**Ingest:** `POST https://cr-track-dashboard.vercel.app/api/ingest`

The extension ships with that ingest URL as the default `crTrack.endpoint`, so a
fresh install reports here with no configuration. A repository's
`.cr-track.yaml` `endpoint:` overrides it, which is how a team points at their
own dashboard later.

## What it does

Each report is stored as two blobs: a small index record that the table renders
from, and the full report, fetched only when a row is expanded. Listing a
hundred reviews therefore costs a hundred small reads, not a hundred full ones.

Reports whose `client.surface` is not `vscode-extension` are treated as test
traffic and hidden behind a toggle, so probes never distort the counts.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/ingest` | Receive a review report |
| `GET` | `/api/ingest` | Liveness — describes what it accepts |
| `GET` | `/api/reviews?limit=200` | Index records, newest first |
| `GET` | `/api/review?key=…` | One full report |

`/api/ingest` returns `422` for a payload that is not a CR-Track report, `400`
for malformed JSON, and `503` if storage fails — `5xx` on purpose, because the
extension queues and retries those rather than dropping them.

## Deploying

```
VERCEL_TOKEN=… VERCEL_TEAM_ID=… node deploy.js
```

Uploads the directory through Vercel's REST API. Dependencies are installed by
Vercel at build time, so nothing needs to be installed locally.

Storage is a Vercel Blob store (`cr-track-data`) connected to the project, which
injects `BLOB_READ_WRITE_TOKEN` at runtime.

## Access

The ingest endpoint is open by default, which is what makes a fresh install
report with no setup. It also means anyone with the URL can post to it, and that
`/api/reviews` exposes developer emails and commit messages to anyone who asks.
For a stand-in dashboard on an unguessable URL that is a deliberate trade; it is
not one to carry into the real one.

To close it, set `CR_TRACK_INGEST_TOKEN` on the Vercel project and the same
value in each developer's environment — the extension already sends it as a
bearer token. Reads stay public either way.

Known limits, none of which matter at this scale but all of which would in a
real dashboard: the index lists at most 1000 reviews, each page load fetches
every index record it shows, and stored reports are public blobs.

> Deployment protection must stay off for this project. With Vercel
> Authentication on, every report gets a `401` and silently queues on the
> developer's machine.

## Replacing this with the real dashboard

Implement `POST /api/ingest` against the same contract and change
`crTrack.endpoint`. The payload shape is documented in
[`skill/references/payload-schema.md`](../skill/references/payload-schema.md);
the required fields are `source` (exactly `claude-code-skill`), `schemaVersion`,
`review`, `developer`, `repository`, `findings`, `changes` and `summary`.
