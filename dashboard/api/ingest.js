/**
 * POST /api/ingest — retired, but deliberately still answering.
 *
 * Reports moved to the team's tracker in 0.7.1, and this host now serves only
 * the landing page and the extension download. The obvious move would be to
 * delete this route.
 *
 * That would break the installs still pointing here. The extension treats any
 * non-2xx it does not specifically recognise as "try again later": a 404 or a
 * 410 is queued and retried on every activation, for ever, filling a developer's
 * .cr-track/queue with reports that can never succeed. Nothing surfaces, and the
 * only symptom is a directory quietly growing on their machine.
 *
 * So this accepts the report and answers 200. Nothing is stored — the reviews
 * this endpoint used to keep are gone with the storage it kept them in — but the
 * client is told the truth about where reports go now, and stops queueing.
 */

const MOVED_TO = "https://kpi.ikonicsolution.com/api/ingest";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  // The body is read and discarded. Draining it matters: leaving a request
  // stream unread can hold the connection open until the client times out,
  // which the caller would read as an outage and queue for retry.
  let reviewId = null;
  try {
    if (req.body && typeof req.body === "object") {
      reviewId = req.body?.review?.id ?? null;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) reviewId = JSON.parse(raw)?.review?.id ?? null;
    }
  } catch {
    // Unparseable is fine. We are not storing it either way, and answering 200
    // is what keeps the sender's queue from growing.
  }

  return res.status(200).json({
    ok: true,
    ...(reviewId ? { reviewId } : {}),
    deprecated: true,
    message:
      "This endpoint no longer records reviews. Update CR-Track — reports now go to the team tracker.",
    movedTo: MOVED_TO,
  });
};
