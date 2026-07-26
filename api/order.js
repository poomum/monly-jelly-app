// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Order API (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/order.js
//   POST  /api/order    → บันทึกออเดอร์ + เพิ่มยอดจองในรอบ + แจ้งลูกค้าทาง LINE
//   GET   /api/order    → (แอดมิน) ดูออเดอร์ทั้งหมด
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

  if (req.method !== "POST" && req.method !== "PATCH") {
    res.status(405).json({ error: "method not allowed" }); return;
  }

  // ── แอดมินอัปเดตสถานะออเดอร์ ──
  if (req.method === "PATCH") {
    const adminKey = process.env.ADMIN_KEY;
    if (adminKey && req.headers["x-admin-key"] !== adminKey) {
      res.status(401).json({ error: "unauthorized" }); return;
    }
    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const { orderId, status, trackingNumber: manualTrackingNumber } = body;
    if (!orderId) { res.status(400).json({ error: "orderId required" }); return; }
    const id = String(orderId).trim().toUpperCase();
    const existing = await kv.get(`order:${id}`);
    if (!existing) { res.status(404).json({ error: "order not found" }); return; }

    // ── ถ้าเปลี่ยนเป็น "shipped" และไม่ได้พิมพ์เลขแทร็กกิ้งมาเอง
    //    → ดึงเลขถัดไปจาก "คลังเลขพัสดุ" ของขนส่งที่ลูกค้าเลือกไว้ตอนสั่งซื้อ ให้อัตโนมัติ ──
    let trackingNumber = manualTrackingNumber;
    let drawnFromPool = false;
    let poolCarrier = null;
    if (status === "shipped" && !trackingNumber && !existing.trackingNumber) {
      poolCarrier = existing.shipping && existing.shipping.id; // "regular" | "ems" | "flash" | "kerry"
      if (poolCarrier) {
        const drawn = await kv.lpop(`tracking:pool:${poolCarrier}`);
        if (drawn) {
          trackingNumber = drawn;
          drawnFromPool = true;
        }
      }
    }

    const updated = {
      ...existing,
      ...(status ? { status } : {}),
      ...(trackingNumber ? { trackingNumber } : {}),
      updatedAt: new Date().toISOString(),
    };
    await kv.set(`order:${id}`, updated);

    // แจ้งลูกค้าทาง LINE เมื่อสถานะเปลี่ยน
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (status && existing.userId && accessToken) {
      const STATUS_LABEL = {
        pending_payment: "รอชำระเงิน 💰",
        paid: "พร้อมรับออเดอร์แล้ว ✅",
        processing: "กำลังดำเนินการเตรียมสินค้า 🍬",
        packed: "แพ็กสินค้าเรียบร้อย 📦",
        shipped: "พร้อมจัดส่งสินค้าไปยังคุณลูกค้า 🚚",
        delivered: "ถึงมือลูกค้าแล้ว 🎉",
        cancelled: "ยกเลิกออเดอร์ ❌",
      };
      const label = STATUS_LABEL[status] || status;
      const liffId = process.env.LIFF_ID;
      const trackLink = liffId ? `https://liff.line.me/${liffId}?orderId=${id}` : null;
      const trackLine = trackLink
        ? `🔗 ติดตามสถานะออเดอร์ได้ตลอดเวลาที่ลิงก์นี้:\n${trackLink}`
        : `พิมพ์ "ติดตาม" ในแชทนี้เพื่อเช็คสถานะได้ตลอดค่ะ`;
      const supportLine = "หากมีข้อสงสัยสอบถามเพิ่มเติมได้ทางแชทนี้ตลอดเวลาทำการเลยนะคะ 💚";

      let text;
      if (status === "paid") {
        text =
          `✅ ยืนยันการชำระเงินเรียบร้อยแล้วค่ะ! 🎉\n\n` +
          `📦 ออเดอร์ #${id} ${label}\n\n` +
          `⏳ สินค้านี้เป็นสินค้า Pre-Order นะคะ หลังชำระเงินทางร้านจะใช้เวลาประมาณ 3-4 วันทำการในการเตรียมและจัดส่งสินค้าให้คุณลูกค้าค่ะ\n\n` +
          `ตอนนี้ออเดอร์ของคุณกำลังอยู่ระหว่างดำเนินการ (3-4 วัน) หลังจากทำขนมเสร็จเรียบร้อย ทางร้านจะอัปเดตสถานะเป็น "พร้อมจัดส่งสินค้า" พร้อมเลขพัสดุให้ทันทีค่ะ\n\n` +
          `${trackLine}\n\n${supportLine}`;
      } else if (status === "shipped") {
        const trackNoLine = trackingNumber ? `📮 เลขพัสดุ: ${trackingNumber}\n\n` : "";
        text =
          `🚚 ${label}\n\n` +
          `📦 ออเดอร์ #${id}\n\n` +
          trackNoLine +
          `กรุณาเช็คสถานะและเลขแทร็กกิ้งได้ตามลิงก์ด้านล่างค่ะ:\n${trackLink || "พิมพ์ \"ติดตาม\" ในแชทนี้ได้เลยค่ะ"}\n\n${supportLine}`;
      } else {
        const trackNoLine = trackingNumber ? `\n📮 เลขพัสดุ: ${trackingNumber}` : "";
        text =
          `📢 อัปเดตออเดอร์ #${id}\n\n` +
          `สถานะล่าสุด: ${label}${trackNoLine}\n\n` +
          `${trackLine}\n\n${supportLine}`;
      }

      await linePush(existing.userId, [{ type: "text", text }], accessToken);
    }

    const poolRemaining = poolCarrier ? await kv.llen(`tracking:pool:${poolCarrier}`).catch(() => null) : null;
    res.status(200).json({
      ok: true,
      order: updated,
      trackingNumberDrawnFromPool: drawnFromPool,
      poolCarrier,
      poolRemaining,
      ...(drawnFromPool && poolRemaining === 0
        ? { poolWarning: `เลขพัสดุของ "${poolCarrier}" ในคลังหมดแล้ว กรุณาเติมเลขชุดใหม่ผ่าน /api/tracking-pool` }
        : {}),
    });
    return;
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

  // push LINE confirmation to customer (ก่อนชำระเงิน)
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
      `\nกรุณาโอนชำระแล้วส่งสลิปกลับมาในแชทนี้นะคะ 💚\n\n` +
      `หากมีข้อสงสัยสอบถามเพิ่มเติมได้ทางแชทนี้ตลอดเวลาทำการเลยนะคะ 💚`;
    await linePush(order.userId, [{ type: "text", text }], accessToken);
  }

  res.status(200).json({ ok: true, orderId, order: record });
};
