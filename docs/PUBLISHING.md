# Publishing CR-Track to the VS Code Marketplace

Total setup: **two free accounts, one token, about 20 minutes.** No server, no
hosting cost, nothing to deploy. Microsoft stores and serves the extension.

Your dev server hosts exactly one thing, unchanged by any of this: the dashboard
and its `/api/ingest` endpoint.

---

## Before you start

```bash
cd extension
npm run preflight
```

Must print **`no blockers`**. It checks the things that are cheap to verify and
expensive to get wrong — in particular that the ruleset and language guides are
bundled, because an extension that ships without them installs fine and quietly
reviews worse.

> **The marketplace has no unpublish for a single version.** A bad publish is
> fixed by publishing a higher version, never by removing the broken one. That
> is why the preflight exists.

---

## Step 1 — Microsoft account

Use an account the **team** owns, not a personal one. Whoever holds it controls
the listing, and moving a publisher later is a support ticket.

If you already have a Microsoft/Outlook account for the team, use it. Otherwise
create one at <https://signup.live.com>.

---

## Step 2 — Azure DevOps organisation

Go to <https://dev.azure.com> and sign in with that account. If prompted, create
an organisation — any name, it is never shown to users.

This is a **free signup used only to mint a token**. No VM, no pipeline, nothing
running, no cost. It exists to prove you own the publisher name.

---

## Step 3 — Personal Access Token

1. In Azure DevOps, click your avatar (top right) → **Personal access tokens**
2. **+ New Token**
3. Fill in exactly:

   | Field | Value |
   |---|---|
   | Name | `vsce-publish` |
   | **Organization** | **All accessible organizations** |
   | Expiration | 90 days, or Custom up to 1 year |
   | **Scopes** | click **Show all scopes**, find **Marketplace**, tick **Manage** |

4. **Create**, then copy the token.

> Two mistakes account for nearly every "401 Unauthorized" at publish time:
> **Organization** left on a single org instead of *All accessible*, and
> **Marketplace → Manage** not ticked (it is hidden until you click *Show all
> scopes*).
>
> **The token is shown once.** Put it in your password manager now.

---

## Step 4 — Create the publisher

Go to <https://marketplace.visualstudio.com/manage> and sign in with the same
account. Click **Create publisher**.

| Field | Value |
|---|---|
| **ID** | `ikonic` |
| Display name | Ikonic |

**The ID must exactly match `publisher` in `extension/package.json`.**

At the time of writing `ikonic` was unclaimed. If it is taken, pick another and
update the manifest — the two must agree or publishing fails:

```bash
cd extension
npm pkg set publisher=your-new-id
npm run preflight
```

Changing the publisher ID changes the extension's identity (`publisher.name`),
so decide before the first publish, not after.

---

## Step 5 — Publish

```bash
cd extension
npx vsce login ikonic     # paste the token from step 3
npm run preflight         # must say: no blockers
npx vsce publish
```

Live in 5–15 minutes after Microsoft's scan, at:

```
https://marketplace.visualstudio.com/items?itemName=ikonic.cr-track
```

Your team then installs it the normal way — Extensions panel, search
"CR-Track", **Install**.

---

## Shipping refinements

```bash
npx vsce publish patch     # 0.1.0 -> 0.1.1
npx vsce publish minor     # 0.1.0 -> 0.2.0
```

This bumps the version, packages and uploads in one command. Everyone who has it
installed **auto-updates within a few hours** — no action from them.

Add a `CHANGELOG.md` entry first; the preflight warns if the version you are
publishing has no entry, and the listing shows those notes.

### Publishing from CI instead

Add the token as a repository secret named `VSCE_PAT`
(GitHub → Settings → Secrets and variables → Actions). The existing
[`release.yml`](../.github/workflows/release.yml) then publishes on every tag:

```bash
npm version patch --prefix extension
git commit -am "Release v0.1.1" && git tag v0.1.1
git push && git push --tags
```

Without the secret the workflow still runs and attaches the `.vsix` to a GitHub
Release — it just skips the marketplace step.

---

## After the first publish

**The listing is public.** Anyone can install it. That is fine for the code, but
two things follow.

**Nobody gets your dashboard by default.** Reports are only uploaded when an
`endpoint` is configured, and the extension hardcodes none. A stranger who
installs it sends you nothing.

**Your team needs the endpoint set.** Best option is committing a
`.cr-track.yaml` to each team repo:

```yaml
endpoint: https://your-dev-server/api/ingest
```

Zero per-developer setup, and it only affects your repositories. The
`crTrack.endpoint` VS Code setting is the per-person alternative.

**Secure the endpoint before the listing goes live.** Once a public extension
can reach it, an unauthenticated ingest URL is an open write endpoint. Serve it
over HTTPS with a real certificate and require `CR_TRACK_INGEST_TOKEN`.

---

## Rolling back

There is no unpublish for a single version.

```bash
npx vsce unpublish ikonic.cr-track   # removes the WHOLE extension, not one version
```

To undo a bad release, fix it and publish a higher version. Users on the broken
one pick up the fix on their next update check.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 Unauthorized` | Token scope is not Marketplace → **Manage**, or Organization is not **All accessible**. Re-create it. |
| `Publisher 'ikonic' not found` | Publisher not created yet (step 4), or the ID does not match the manifest. |
| `Extension 'private' cannot be published` | `"private": true` is back in `package.json`. |
| `ERROR Make sure to edit the README.md` | The README still has vsce's placeholder text. |
| Installs, but does nothing | Almost always the Claude CLI: not installed, or not signed in. **CR-Track: Show Log** says which. |
| Log says *Guides not found* | Published without running the build. `npm run preflight` catches this. |
