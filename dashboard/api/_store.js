/**
 * Storage.
 *
 * Two blobs per review, on purpose:
 *
 *   index/<key>.json    a few hundred bytes — everything the table renders
 *   reviews/<key>.json  the full report, read only when a row is expanded
 *
 * Listing gives us pathnames but not contents, so a single-blob design would
 * mean fetching every full report to draw the table. At a hundred reviews that
 * is megabytes for a page that shows counts.
 */

const { put, list } = require("@vercel/blob");

const INDEX = "index/";
const FULL = "reviews/";

/** Sortable, unique, and readable in the blob browser. */
function keyFor(record) {
  const stamp = record.receivedAt.replace(/[:.]/g, "-");
  return `${stamp}__${record.id}`;
}

async function save(record, full) {
  const key = keyFor(record);
  // The page needs the key to ask for the full report later, so it travels
  // inside the index record rather than being reconstructed from its parts.
  record.key = key;
  const opts = {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    // Each key is written exactly once, so the content behind it can never
    // change and a long cache is free.
    cacheControlMaxAge: 31536000,
  };
  await Promise.all([
    put(`${INDEX}${key}.json`, JSON.stringify(record), opts),
    put(`${FULL}${key}.json`, JSON.stringify(full), opts),
  ]);
  return key;
}

/** Newest first. */
async function recent(limit = 200) {
  const { blobs } = await list({ prefix: INDEX, limit: 1000 });
  const newest = blobs
    .sort((a, b) => b.pathname.localeCompare(a.pathname))
    .slice(0, limit);

  const settled = await Promise.allSettled(
    newest.map((b) => fetch(b.url).then((r) => (r.ok ? r.json() : null))),
  );
  // One unreadable blob must not blank the whole page.
  return settled
    .filter((s) => s.status === "fulfilled" && s.value)
    .map((s) => s.value);
}

async function full(key) {
  const { blobs } = await list({ prefix: `${FULL}${key}.json`, limit: 1 });
  if (!blobs.length) return null;
  const res = await fetch(blobs[0].url);
  return res.ok ? res.json() : null;
}

module.exports = { save, recent, full };
