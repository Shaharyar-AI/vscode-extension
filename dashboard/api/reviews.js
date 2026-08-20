/** GET /api/reviews — the table's data. */

const { recent } = require("./_store");

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "no-store");

  const limit = Math.min(Number(req.query?.limit) || 200, 500);
  try {
    const reviews = await recent(limit);
    return res.status(200).json({ ok: true, count: reviews.length, reviews });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
