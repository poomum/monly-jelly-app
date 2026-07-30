// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Order Status Lookup (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/order-status.js
//   GET /api/order-status?orderId=MJ-XXXXXX        → เช็คสถานะออเดอร์เดียว
//   GET /api/order-status?userId=U...               → ดึงออเดอร์ล่าสุดของลูกค้าคนนั้น (ใช้จากหน้าเว็บ)
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

const STATUS_LABEL = {
  pending_payment: { label: "รอชำระเงิน", emoji: "💰", step: 1 },
  paid: { label: "พร้อมรับออเดอร์แล้ว กำลังเตรียมสินค้า (3-4 วัน)", emoji: "✅", step: 2 },
  processing: { label: "กำลังดำเนินการเตรียมสินค้า", emoji: "🍬", step: 3 },
  packed: { label: "แพ็กสินค้าเรียบร้อย", emoji: "📦", step: 4 },
  shipped: { label: "พร้อมจัดส่งสินค้าไปยังคุณลูกค้า", emoji: "🚚", step: 5 },
  delivered: { label: "ถึงมือลูกค้าแล้ว", emoji: "🎉", step: 6 },
  cancelled: { label: "ยกเลิกออเดอร์", emoji: "❌", step: 0 },
};

function publicOrderView(o) {
  if (!o) return null;
  const st = STATUS_LABEL[o.status] || STATUS_LABEL.pending_payment;
  return {
    orderId: o.orderId,
    status: o.status || "pending_payment",
    statusLabel: st.label,
    statusEmoji: st.emoji,
    statusStep: st.step,
    round: o.round ? { date: o.round.date } : null,
    items: (o.items || []).map((it) => ({ name: it.name, qty: it.qty })),
    grandTotal: o.grandTotal,
    shipping: o.shipping ? { name: o.shipping.name } : null,
    trackingNumber: o.trackingNumber || null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt || o.createdAt,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }

  const { orderId, userId } = req.query;

  // ── เช็คด้วยเลขออเดอร์ (ลูกค้าพิมพ์เอง หรือ LINE bot ใช้) ──
  if (orderId) {
    const id = String(orderId).trim().toUpperCase();
    const o = await kv.get(`order:${id}`);
    if (!o) { res.status(404).json({ error: "not found" }); return; }
    res.status(200).json({ ok: true, order: publicOrderView(o) });
    return;
  }

  // ── ดึงออเดอร์ล่าสุดของลูกค้า (ใช้อัตโนมัติจากหน้าเว็บตอนเปิดผ่าน LINE) ──
  if (userId) {
    const ids = (await kv.smembers(`orders:user:${userId}`)) || [];
    const orders = [];
    for (const id of ids) {
      const o = await kv.get(`order:${id}`);
      if (o) orders.push(o);
    }
    orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.status(200).json({ ok: true, orders: orders.map(publicOrderView) });
    return;
  }

  res.status(400).json({ error: "ต้องระบุ orderId หรือ userId" });
};
