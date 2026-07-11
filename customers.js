// ═══════════════════════════════════════════════════════════════
// Monly Jelly – List Customers (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/customers.js
// GET /api/customers  → ดูรายชื่อลูกค้าทั้งหมดที่เพิ่มเพื่อนแล้ว
// ═══════════════════════════════════════════════════════════════

const { kv } = require("@vercel/kv");

module.exports = async (req, res) => {
  const ids = (await kv.smembers("customers:index")) || [];
  const customers = [];
  for (const id of ids) {
    const c = await kv.get(`customer:${id}`);
    if (c) customers.push(c);
  }
  customers.sort(
    (a, b) => new Date(b.followedAt || 0) - new Date(a.followedAt || 0)
  );
  res.status(200).json({
    total: customers.length,
    following: customers.filter((c) => c.isFollowing).length,
    customers,
  });
};
