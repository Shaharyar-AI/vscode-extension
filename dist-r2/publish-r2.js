/**
 * Publish the installer and the .vsix to Cloudflare R2.
 *
 * Creates the bucket if it does not exist, turns on the managed r2.dev public
 * hostname, bakes that hostname into install.sh, and uploads everything.
 *
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... node publish-r2.js
 *
 * The API token needs "Workers R2 Storage: Edit".
 */

const fs = require("node:fs");
const path = require("node:path");

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN = process.env.CF_API_TOKEN;
const BUCKET = process.env.CF_BUCKET || "cr-track-releases";

if (!ACCOUNT || !TOKEN) {
  console.error("Set CF_ACCOUNT_ID and CF_API_TOKEN");
  process.exit(2);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets`;
const auth = { authorization: `Bearer ${TOKEN}` };
const DIR = __dirname;

async function cf(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, body };
}

/** Cloudflare reports "already exists" as an error; that is a success here. */
async function ensureBucket() {
  const made = await cf(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: BUCKET }),
  });
  if (made.ok) return "created";
  const msg = JSON.stringify(made.body);
  if (/already exists|10004|duplicate/i.test(msg)) return "exists";
  throw new Error(`Could not create bucket: ${made.status} ${msg.slice(0, 300)}`);
}

/** Turn on the managed r2.dev hostname and return it. */
async function enablePublic() {
  // Set R2_PUBLIC_HOST to skip the API entirely when public access was
  // switched on by hand in the dashboard.
  if (process.env.R2_PUBLIC_HOST) {
    return process.env.R2_PUBLIC_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  const on = await cf(`${API}/${BUCKET}/domains/managed`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  const read = await cf(`${API}/${BUCKET}/domains/managed`);
  const host = read.body?.result?.domain || on.body?.result?.domain;
  if (host) return host;
  // Returning null rather than throwing: this endpoint has been seen answering
  // 10001 "internal error" to every request including GET, and a broken toggle
  // must not cost us the uploads.
  console.log("note: the API would not enable public access " +
    `(${JSON.stringify(on.body?.errors ?? on.body).slice(0, 120)})`);
  return null;
}

async function upload(key, data, contentType) {
  const res = await fetch(`${API}/${BUCKET}/objects/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { ...auth, "content-type": contentType },
    body: data,
  });
  if (!res.ok) {
    throw new Error(`Upload of ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return key;
}

(async () => {
  const version = fs.readFileSync(path.join(DIR, "version.txt"), "utf8").trim();
  const vsix = fs.readFileSync(path.join(DIR, "cr-track-latest.vsix"));
  const script = fs.readFileSync(path.join(DIR, "install.sh"), "utf8");

  console.log(`bucket   ${BUCKET}`);
  console.log(`version  ${version}`);
  console.log(`vsix     ${vsix.length} bytes\n`);

  console.log("bucket:", await ensureBucket());
  const host = await enablePublic();
  const base = host ? `https://${host}` : null;
  console.log("public:", base ?? "NOT ENABLED");

  if (base) {
    // The published script must work with no environment variables set, so the
    // real host replaces the placeholder on the way up. The copy on disk keeps
    // the placeholder — that is what makes an unconfigured one obvious.
    const configured = script.split("https://REPLACE_WITH_R2_HOST").join(base);
    if (configured === script) throw new Error("install.sh has no placeholder to replace");

    // text/plain so curl and a browser both show it rather than downloading it;
    // people should be able to read this before piping it into a shell.
    await upload("install.sh", configured, "text/plain; charset=utf-8");
    console.log("uploaded install.sh");
  } else {
    console.log("skipped install.sh — it needs the real host baked in");
  }

  await upload("version.txt", version, "text/plain; charset=utf-8");
  console.log("uploaded version.txt");

  await upload("cr-track-latest.vsix", vsix, "application/octet-stream");
  console.log("uploaded cr-track-latest.vsix");

  await upload(`cr-track-${version}.vsix`, vsix, "application/octet-stream");
  console.log(`uploaded cr-track-${version}.vsix`);

  // Shipped alongside the installer because "it says inactive" is the support
  // question, and a one-liner that answers it beats a paragraph of instructions.
  const doctor = fs.readFileSync(path.join(DIR, "doctor.sh"), "utf8");
  await upload("doctor.sh", doctor, "text/plain; charset=utf-8");
  console.log("uploaded doctor.sh");

  if (base) {
    console.log("");
    console.log(`Install:   curl -fsSL ${base}/install.sh | bash`);
    console.log(`Diagnose:  curl -fsSL ${base}/doctor.sh | bash`);
    console.log("");
  } else {
    console.log("");
    console.log("Everything is uploaded except install.sh.");
    console.log("");
    console.log("Enable public access once in the dashboard:");
    console.log(`  dash.cloudflare.com -> R2 -> ${BUCKET} -> Settings`);
    console.log("  -> Public Development URL -> Enable");
    console.log("");
    console.log("Then re-run with the URL it shows:");
    console.log("  R2_PUBLIC_HOST=pub-xxxx.r2.dev node publish-r2.js");
    console.log("");
  }
})().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
