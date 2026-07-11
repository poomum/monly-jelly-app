// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Order API (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/order.js
//   POST  /api/order    → บันทึกออเดอร์ + เพิ่มยอดจองในรอบ + แจ้งลูกค้าทาง LINE
//   GET   /api/order    → (แอดมิน) ดูออเดอร์ทั้งหมด
// ═══════════════════════════════════════════════════════════════

const { kv } = require("@vercel/kv");

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

function genOrderId() {
  return "MJ-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function linePush(userId, messages, accessToken) {
  if (!userId || !accessToken) return;
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    });
  } catch (e) { console.error("LINE push failed:", e); }
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // ── ดูออเดอร์ทั้งหมด (แอดมิน) ──
  if (req.method === "GET") {
    const adminKey = process.env.ADMIN_KEY;
    if (adminKey && req.headers["x-admin-key"] !== adminKey) {
      res.status(401).json({ error: "unauthorized" }); return;
    }
    const ids = (await kv.smembers("orders:index")) || [];
    const orders = [];
    for (const id of ids) {
      const o = await kv.get(`order:${id}`);
      if (o) orders.push(o);
    }
    orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.status(200).json({ total: orders.length, orders });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" }); return;
  }

  // ── บันทึกออเดอร์ใหม่ ──
  let order = {};
  try { const raw = await getRawBody(req); order = raw ? JSON.parse(raw) : {}; }
  catch { res.status(400).json({ error: "invalid json" }); return; }

  const orderId = genOrderId();
  const record = {
    orderId,
    ...order,
    status: "pending_payment",
    createdAt: order.createdAt || new Date().toISOString(),
  };

  // save order
  await kv.set(`order:${orderId}`, record);
  await kv.sadd("orders:index", orderId);
  if (order.userId) await kv.sadd(`orders:user:${order.userId}`, orderId);

  // increment booked count in the chosen round
  if (order.round && order.round.id) {
    const rounds = (await kv.get("rounds:all")) || [];
    const idx = rounds.findIndex((r) => r.id === order.round.id);
    if (idx >= 0) {
      const qty = (order.items || []).reduce((s, it) => s + (it.qty || 0), 0);
      rounds[idx].booked = Math.min(
        rounds[idx].capacity,
        (rounds[idx].booked || 0) + Math.max(1, qty ? 1 : 1) // 1 การจอง = 1 ที่นั่ง
      );
      await kv.set("rounds:all", rounds);
    }
  }

  // push LINE confirmation to customer
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (order.userId && accessToken) {
    const itemLines = (order.items || [])
      .map((it) => `• ${it.name} ×${it.qty} = ฿${it.price * it.qty}`)
      .join("\n");
    const c = order.customer || {};
    const text =
      `🎉 ยืนยันการจอง #${orderId}\n\n` +
      `📅 รอบผลิต: ${order.round ? order.round.date : "-"}\n\n` +
      `🛒 รายการ:\n${itemLines}\n\n` +
      `🚚 จัดส่ง: ${order.shipping ? order.shipping.name : "-"} ฿${order.shipping ? order.shipping.price : 0}\n` +
      `💰 ยอดรวม: ฿${order.grandTotal}\n\n` +
      `📦 ผู้รับ: ${c.name || "-"}\n📞 ${c.phone || "-"}\n🏠 ${c.addr || "-"}\n` +
      (c.email ? `✉️ ${c.email}\n` : "") +
      `\nกรุณาโอนชำระแล้วส่งสลิปกลับมาในแชทนี้นะคะ 💚`;
    await linePush(order.userId, [{ type: "text", text }], accessToken);
  }

  res.status(200).json({ ok: true, orderId, order: record });
};
