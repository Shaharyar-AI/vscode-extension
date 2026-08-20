/** GET /api/review?key=... — the full report behind one row. */

const { full } = require("./_store");

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "no-store");

  const key = String(req.query?.key || "");
  // The key goes straight into a blob prefix, so anything path-like is refused
  // rather than sanitised — there is no legitimate key containing a slash.
  if (!key || !/^[A-Za-z0-9._-]+$/.test(key)) {
    return res.status(400).json({ ok: false, error: "Bad key" });
  }

  try {
    const report = await full(key);
    if (!report) return res.status(404).json({ ok: false, error: "Not found" });
    return res.status(200).json({ ok: true, report });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
