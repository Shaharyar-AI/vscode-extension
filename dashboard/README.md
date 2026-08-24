# CR-Track — download host and landing page

This host serves two things:

- **The landing page** at `/` — what the extension does, and how to install it.
- **The extension itself**: `version.txt`, `cr-track-latest.vsix`, and the
  `install` / `doctor` scripts for both platforms. The install URL is stable and
  must stay that way; it is what every developer has.

**Live:** https://cr-track-dashboard.vercel.app

## Reports do not come here any more

Since 0.7.1 they go to the team tracker at
`https://ikonictracker.demosites.cc/api/ingest`, which authenticates each
developer with a personal ingest token.

`/api/ingest` still answers here, and deliberately returns **200**. Installs
older than 0.7.1 still post to it, and the extension retries anything it does not
recognise as a permanent failure — so deleting the route would fill those
developers' `.cr-track/queue` with reports that can never succeed, with no
symptom other than a directory quietly growing. It accepts the report, stores
nothing, and tells the caller where reports go now.

The review-listing endpoints (`/api/reviews`, `/api/review`) and the blob storage
behind them are gone: the page that used them no longer exists.

## Publishing a new version

Copy the built `.vsix` to `public/cr-track-latest.vsix`, write the version into
`public/version.txt`, then:

```bash
node deploy.js
```

The install URL never changes.
