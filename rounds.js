// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Production Rounds API (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/rounds.js
//   GET   /api/rounds          → รายการรอบผลิตทั้งหมด + ที่นั่งว่าง
//   POST  /api/rounds          → (แอดมิน) เพิ่ม/แก้รอบ  body:{rounds:[...]}
// ═══════════════════════════════════════════════════════════════

const { kv } = require("@vercel/kv");

// รอบเริ่มต้น (ใช้ครั้งแรกถ้ายังไม่เคยตั้งค่าใน KV)
const DEFAULT_ROUNDS = [
  { id: "r1", date: "20 ก.ค. 2568", capacity: 20, booked: 20 },
  { id: "r2", date: "27 ก.ค. 2568", capacity: 20, booked: 15 },
  { id: "r3", date: "3 ส.ค. 2568", capacity: 20, booked: 4 },
  { id: "r4", date: "10 ส.ค. 2568", capacity: 20, booked: 0 },
];

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method === "GET") {
    let rounds = await kv.get("rounds:all");
    if (!rounds) {
      rounds = DEFAULT_ROUNDS;
      await kv.set("rounds:all", rounds);
    }
    res.status(200).json({ rounds });
    return;
  }

  if (req.method === "POST") {
    // (ออปชัน) ป้องกันด้วย ADMIN_KEY ถ้าตั้งไว้ใน env
    const adminKey = process.env.ADMIN_KEY;
    if (adminKey && req.headers["x-admin-key"] !== adminKey) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let payload = {};
    try { const raw = await getRawBody(req); payload = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }
    if (!Array.isArray(payload.rounds)) {
      res.status(400).json({ error: "rounds array required" }); return;
    }
    await kv.set("rounds:all", payload.rounds);
    res.status(200).json({ ok: true, rounds: payload.rounds });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};
