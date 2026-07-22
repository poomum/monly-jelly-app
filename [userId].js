// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Customer API (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/customer/[userId].js
// รองรับ:
//   GET   /api/customer/:userId   → ดึงข้อมูลลูกค้า (ใช้จาก LIFF app)
//   PATCH /api/customer/:userId   → อัปเดตเบอร์/ที่อยู่/ชื่อ จากฟอร์มสั่งซื้อ
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

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports.config = {
  api: { bodyParser: false },
};

module.exports = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    res.status(400).json({ error: "missing userId" });
    return;
  }

  if (req.method === "GET") {
    const customer = await kv.get(`customer:${userId}`);
    if (!customer) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json(customer);
    return;
  }

  if (req.method === "PATCH") {
    let payload = {};
    try {
      const raw = await getRawBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      res.status(400).json({ error: "invalid json body" });
      return;
    }

    const existing = (await kv.get(`customer:${userId}`)) || { userId };
    const { phone, addr, name, email, birth } = payload;
    const updated = {
      ...existing,
      userId,
      ...(phone ? { phone } : {}),
      ...(addr ? { addr } : {}),
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(birth ? { birth } : {}),
      updatedAt: new Date().toISOString(),
    };
    await kv.set(`customer:${userId}`, updated);
    await kv.sadd("customers:index", userId);
    res.status(200).json(updated);
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};
