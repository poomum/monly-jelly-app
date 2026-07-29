// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Admin Activity Log API (Vercel Serverless Function)
// วางไฟล์นี้ที่: /api/admin-log.js
//   GET /api/admin-log            → ดูประวัติการใช้งานล่าสุด 100 รายการ
//   GET /api/admin-log?limit=50   → กำหนดจำนวนที่ต้องการดู (สูงสุด 500)
//   GET /api/admin-log?admin=ชื่อ → กรองดูเฉพาะแอดมินคนนั้น
// ต้อง Login ผ่าน /api/admin-auth ก่อนเสมอ แล้วแนบ session token มา
// ผ่าน header "x-admin-session" (endpoint นี้อ่อนไหวมาก เพราะเห็น
// ภาพรวมว่าใครทำอะไรบ้างในระบบ ไม่มีข้อยกเว้นให้ข้ามการเช็ค)
// ═══════════════════════════════════════════════════════════════

const { kv, validateSession } = require("../lib/adminAuth");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // 🔒 endpoint นี้ต้อง Login เสมอ ไม่มีข้อยกเว้น (ข้อมูลอ่อนไหวมาก)
  const session = await validateSession(req.headers["x-admin-session"]);
  if (!session) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }

  const logData = await kv.get("admin:activity-log");
  let log = logData ? (typeof logData === "string" ? JSON.parse(logData) : logData) : [];

  const { admin: adminFilter, limit: limitRaw } = req.query;
  if (adminFilter) {
    log = log.filter((entry) => entry.admin === adminFilter);
  }

  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100;
  const trimmed = log.slice(0, limit);

  res.status(200).json({ total: log.length, showing: trimmed.length, log: trimmed });
};
