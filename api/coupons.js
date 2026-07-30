// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Coupons API (Vercel Serverless)
// วางไฟล์นี้ที่: /api/coupons.js
// ═══════════════════════════════════════════════════════════════

const { createClient } = require("@vercel/kv");
const kv = createClient({
  url:
    process.env.KV_REST_API_URL ||
    process.env.kv_KV_REST_API_URL ||
    process.env.STORAGE_KV_REST_API_URL,
  token:
    process.env.KV_REST_API_TOKEN ||
    process.env.kv_KV_REST_API_TOKEN ||
    process.env.STORAGE_KV_REST_API_TOKEN,
});

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    if (req.method === "GET") {
      // GET /api/coupons?userId=... → ดึงคูปองทั้งหมดของลูกค้า
      const { userId } = req.query;
      if (!userId) {
        res.status(400).json({ error: "userId required" });
        return;
      }

      const coupons = await kv.get(`coupons:${userId}`);
      const list = coupons
        ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons)
        : [];
      res.status(200).json({ coupons: list });
      return;
    }

    if (req.method === "POST") {
      // POST /api/coupons → สร้างคูปองใหม่
      const { userId, theme, greeting, profileImg } = req.body;
      if (!userId || !theme || !greeting) {
        res.status(400).json({ error: "userId, theme, greeting required" });
        return;
      }

      const coupons = await kv.get(`coupons:${userId}`);
      const list = coupons
        ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons)
        : [];

      const coupon = {
        id: `cpn-${Date.now()}`,
        userId,
        theme, // "pastel-pink", "pastel-purple", "pastel-rainbow", "pastel-green"
        greeting,
        profileImg: profileImg || "", // URL หรือ base64
        createdAt: new Date().toISOString(),
        usedAt: null, // null = ยังไม่ใช้ | ISO string = ใช้ไปแล้ว
        usedInOrderId: null,
      };

      list.push(coupon);
      await kv.set(`coupons:${userId}`, JSON.stringify(list));

      res.status(201).json({ coupon, message: "Coupon created" });
      return;
    }

    if (req.method === "PATCH") {
      // PATCH /api/coupons → ทำเครื่องหมายคูปองว่าใช้แล้ว
      const { userId, couponId, orderId } = req.body;
      if (!userId || !couponId || !orderId) {
        res.status(400).json({ error: "userId, couponId, orderId required" });
        return;
      }

      const coupons = await kv.get(`coupons:${userId}`);
      let list = coupons
        ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons)
        : [];

      list = list.map((c) =>
        c.id === couponId
          ? { ...c, usedAt: new Date().toISOString(), usedInOrderId: orderId }
          : c
      );

      await kv.set(`coupons:${userId}`, JSON.stringify(list));
      res.status(200).json({ message: "Coupon marked as used" });
      return;
    }

    if (req.method === "DELETE") {
      // DELETE /api/coupons?userId=...&couponId=...
      const { userId, couponId } = req.query;
      if (!userId || !couponId) {
        res.status(400).json({ error: "userId and couponId required" });
        return;
      }

      const coupons = await kv.get(`coupons:${userId}`);
      let list = coupons
        ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons)
        : [];
      list = list.filter((c) => c.id !== couponId);

      await kv.set(`coupons:${userId}`, JSON.stringify(list));
      res.status(200).json({ message: "Coupon deleted" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("Coupon API error:", err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = handler;

// ⚠️ ต้องแนบ .config ตรงนี้ "หลัง" module.exports = handler แล้วเท่านั้น
module.exports.config = { api: { bodyParser: true } };
