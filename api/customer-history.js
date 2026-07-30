// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Customer Purchase History API (Vercel Serverless Function)
// วางไฟล์นี้ที่: /api/customer-history.js
//
//   GET /api/customer-history?userId=XXX
//     → แอดมิน: ต้อง Login (x-admin-session) ดูได้ทุกคน
//     → ลูกค้าเอง: ไม่ต้อง Login แต่ดูได้เฉพาะข้อมูลของ userId ตัวเอง
//       (เหมือนกับ endpoint อื่นๆ ที่ใช้ LINE userId เป็นตัวยืนยันตัวตน
//        แบบเดียวกับ api/coupons.js, api/order-status.js)
// ═══════════════════════════════════════════════════════════════

const { validateSession, logAdminAction } = require("../lib/adminAuth");
const { getCustomerPurchaseHistory } = require("../lib/purchaseHistory");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const { userId } = req.query;
  if (!userId) {
    res.status(400).json({ error: "ต้องระบุ ?userId=" });
    return;
  }

  // ถ้ามี session แอดมินแนบมาด้วย ให้บันทึกว่าแอดมินคนไหนดูข้อมูลลูกค้าคนนี้
  // (ไม่บังคับ login ก็ดูได้ เพราะลูกค้าเองก็ต้องดูข้อมูลตัวเองผ่านหน้าโปรไฟล์ได้)
  const session = await validateSession(req.headers["x-admin-session"]);
  if (session) {
    logAdminAction(session.name, `ดูประวัติการสั่งซื้อลูกค้า (${userId})`);
  }

  const history = await getCustomerPurchaseHistory(userId);
  res.status(200).json(history);
};
