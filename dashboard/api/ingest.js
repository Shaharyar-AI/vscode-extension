/**
 * POST /api/ingest — where CR-Track sends a review.
 *
 * Rejecting a report is worse than storing an odd one: the extension queues a
 * rejection and retries it forever, so a fussy validator turns into a growing
 * queue on a developer's machine. Only the fields the page cannot work without
 * are required; everything else is defaulted.
 */

const { save } = require("./_store");

const SOURCE = "claude-code-skill";

function bad(res, status, message, detail) {
  res.status(status).json({ ok: false, error: message, ...(detail ? { detail } : {}) });
}

/** Vercel parses JSON bodies for us, but not when the content-type is odd. */
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Someone will paste this URL into a browser to see whether it is alive.
  // Answering with a usable message costs nothing and saves a support round.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      endpoint: "/api/ingest",
      accepts: "POST application/json",
      expects: { source: SOURCE, schemaVersion: "1.0 or 2.0" },
      dashboard: "/",
    });
  }

  if (req.method !== "POST") return bad(res, 405, "Use POST");

  // Optional shared secret. Unset, the endpoint is open — which is the right
  // default for a stand-in dashboard nobody has a token for yet. Set
  // CR_TRACK_INGEST_TOKEN on the project and every sender must present it; the
  // extension already sends the matching header when the same variable is set
  // in its environment.
  const expected = process.env.CR_TRACK_INGEST_TOKEN;
  if (expected) {
    const presented = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (presented !== expected) return bad(res, 401, "Bad or missing ingest token");
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (err) {
    return bad(res, 400, "Body is not valid JSON", String(err.message || err));
  }
  if (!payload || typeof payload !== "object") return bad(res, 400, "Body must be a JSON object");

  if (payload.source !== SOURCE) {
    return bad(res, 422, `source must be "${SOURCE}"`, `got ${JSON.stringify(payload.source)}`);
  }

  const review = payload.review || {};
  const developer = payload.developer || {};
  const repository = payload.repository || {};
  const commit = review.commit || {};
  const summary = payload.summary || {};
  const stats = payload.diffStats || {};
  const findings = Array.isArray(payload.findings) ? payload.findings : [];

  const bySeverity = summary.bySeverity || {};
  const count = (name) =>
    Number(bySeverity[name] ?? findings.filter((f) => f.severity === name).length) || 0;

  const receivedAt = new Date().toISOString();
  const id = String(review.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40) || String(Date.now());

  const record = {
    id,
    receivedAt,
    completedAt: review.completedAt || receivedAt,
    durationMs: Number(review.durationMs) || 0,
    mode: review.mode || "unknown",
    model: review.model || null,
    effort: review.effort || null,
    developerName: developer.name || developer.gitUser || "unknown",
    developerEmail: developer.email || "unknown",
    repoName: repository.name || "unknown",
    branch: repository.branch || "",
    remote: repository.remote || "",
    commitSha: commit.sha || "",
    commitShort: commit.shortSha || (commit.sha ? String(commit.sha).slice(0, 7) : ""),
    commitMessage: commit.message || "",
    commitAuthor: commit.authorName || developer.name || "",
    filesChanged: Number(stats.filesChanged ?? (stats.files || []).length) || 0,
    linesAdded: Number(stats.linesAdded) || 0,
    linesRemoved: Number(stats.linesRemoved) || 0,
    findingsTotal: Number(summary.findingsTotal ?? findings.length) || 0,
    blocking: count("blocking"),
    important: count("important"),
    nit: count("nit"),
    suggestion: count("suggestion"),
    surface: (payload.client || {}).surface || "unknown",
    extensionVersion: (payload.client || {}).extensionVersion || null,
  };

  try {
    const key = await save(record, payload);
    return res.status(200).json({ ok: true, id: record.id, key });
  } catch (err) {
    // A storage failure is ours, not the sender's. 5xx tells the extension to
    // queue and retry, which is exactly the right behaviour.
    return bad(res, 503, "Could not store the report", String(err.message || err));
  }
};
