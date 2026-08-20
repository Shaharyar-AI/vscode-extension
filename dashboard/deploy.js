/**
 * Deploy this directory to Vercel through the REST API.
 *
 * Uses the API rather than the CLI so nothing has to be installed locally —
 * Vercel runs `npm install` for the declared dependencies at build time.
 *
 *   VERCEL_TOKEN=... node deploy.js
 */

const fs = require("node:fs");
const path = require("node:path");

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM = process.env.VERCEL_TEAM_ID;
const PROJECT = process.env.VERCEL_PROJECT || "cr-track-dashboard";

if (!TOKEN) {
  console.error("Set VERCEL_TOKEN");
  process.exit(2);
}

const ROOT = __dirname;
const SKIP = new Set(["node_modules", ".vercel", ".git", "deploy.js"]);

/**
 * Never upload a dotfile.
 *
 * Everything under this directory is served publicly once deployed, and a
 * `.env` sitting here would be published along with it. Naming files to skip
 * one at a time is how that eventually gets missed.
 */
const isHidden = (name) => name.startsWith(".");

/** Extensions safe to send as text. Everything else is treated as binary. */
const TEXT = /[.](html|css|js|mjs|cjs|json|md|txt|sh|svg|xml|yml|yaml)$/i;

function collect(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || isHidden(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collect(abs, rel));
      continue;
    }
    // Reading a binary file as utf-8 replaces every invalid byte sequence with
    // U+FFFD, which corrupts it silently — the upload succeeds and the download
    // is unusable. Anything not known to be text goes up as base64.
    if (TEXT.test(entry.name)) {
      out.push({ file: rel, data: fs.readFileSync(abs, "utf8"), encoding: "utf-8" });
    } else {
      out.push({ file: rel, data: fs.readFileSync(abs).toString("base64"), encoding: "base64" });
    }
  }
  return out;
}

(async () => {
  const files = collect(ROOT);
  console.log("Uploading:");
  for (const f of files) console.log("  " + f.file);

  const qs = TEAM ? `?teamId=${TEAM}` : "";
  const res = await fetch(`https://api.vercel.com/v13/deployments${qs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: PROJECT,
      project: PROJECT,
      target: "production",
      files,
      projectSettings: { framework: null },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error("\nDeploy failed:", res.status, JSON.stringify(body, null, 2).slice(0, 1200));
    process.exit(1);
  }

  console.log("\nDeployment:", body.id);
  console.log("URL:", "https://" + body.url);

  // Poll to completion so a broken build fails here rather than silently.
  const deadline = Date.now() + 300_000;
  let state = body.readyState || body.status;
  while (Date.now() < deadline && !["READY", "ERROR", "CANCELED"].includes(state)) {
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await fetch(`https://api.vercel.com/v13/deployments/${body.id}${qs}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const info = await poll.json();
    state = info.readyState || info.status;
    process.stdout.write("  " + state + "\n");
  }

  console.log("\nFinal state:", state);
  if (state !== "READY") process.exit(1);
})();
