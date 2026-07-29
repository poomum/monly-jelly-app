// ═══════════════════════════════════════════════════════════════
// Monly Jelly – List Customers (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/customers.js
// GET /api/customers  → ดูรายชื่อลูกค้าทั้งหมดที่เพิ่มเพื่อนแล้ว (แอดมินเท่านั้น)
//
// ต้อง Login ผ่าน /api/admin-auth ก่อน แล้วแนบ session token มาผ่าน
// header "x-admin-session" (ดูวิธี Login ในไฟล์ admin-login.html)
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

const { validateSession, logAdminAction } = require("../lib/adminAuth");

module.exports = async (req, res) => {
  // 🔒 ป้องกันด้วย Session Login — ข้อมูลนี้มีชื่อ/เบอร์/ที่อยู่/วันเกิดลูกค้า
  //    ต้องไม่เปิดให้ใครก็เข้าถึงได้โดยไม่ Login ก่อน
  const session = await validateSession(req.headers["x-admin-session"]);
  if (!session) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }
  logAdminAction(session.name, "ดูรายชื่อลูกค้าทั้งหมด");

  const ids = (await kv.smembers("customers:index")) || [];
  // ดึงข้อมูลลูกค้าทั้งหมดแบบขนาน (เร็วขึ้นมาก รองรับลูกค้าหลักพันคนได้)
  const fetched = await Promise.all(ids.map((id) => kv.get(`customer:${id}`)));
  let customers = fetched.filter(Boolean);

  customers.sort(
    (a, b) => new Date(b.followedAt || 0) - new Date(a.followedAt || 0)
  );

  const totalMatched = customers.length;

  // แบ่งหน้า (ออปชัน — ถ้าไม่ระบุ limit จะส่งทั้งหมดเหมือนเดิม เพื่อไม่ให้
  // กระทบเครื่องมือเก่าที่เคยเรียกใช้แบบไม่แบ่งหน้า) เช่น ?limit=100&page=2
  const limit = req.query.limit ? Math.max(1, Math.min(500, Number(req.query.limit))) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  if (limit) {
    const start = (page - 1) * limit;
    customers = customers.slice(start, start + limit);
  }

  res.status(200).json({
    total: totalMatched,
    following: fetched.filter(Boolean).filter((c) => c.isFollowing).length,
    page: limit ? page : 1,
    totalPages: limit ? Math.ceil(totalMatched / limit) : 1,
    customers,
  });
};
