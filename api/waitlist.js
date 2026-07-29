// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Waitlist API (Vercel Serverless Function)
// วางไฟล์นี้ที่: /api/waitlist.js
//   POST /api/waitlist   → ต่อคิวสำรองสำหรับรอบที่เต็มแล้ว
//   GET  /api/waitlist?roundId=...  → ดูคิวสำรองของรอบนั้น (แอดมิน/เช็คลำดับตัวเอง)
//   DELETE /api/waitlist?roundId=...&userId=...  → ออกจากคิวสำรองเอง
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

async function getWaitlist(roundId) {
  const data = await kv.get(`waitlist:${roundId}`);
  if (!data) return [];
  return typeof data === "string" ? JSON.parse(data) : data;
}

// ── ระบบ Login แอดมิน (session-based) — ใช้ไฟล์กลางร่วมกับ api อื่นๆ ──
const { validateSession, logAdminAction } = require("../lib/adminAuth");

async function saveWaitlist(roundId, list) {
  await kv.set(`waitlist:${roundId}`, JSON.stringify(list));
}

// ── ราคาจริงที่อ้างอิงได้ (ต้องตรงกับ index.html และ api/order.js เป๊ะ) ──
// ห้ามเชื่อราคา/ยอดรวมที่ส่งมาจากฝั่งลูกค้าเด็ดขาด เช็คซ้ำเหมือน order.js ทุกจุด
const CANONICAL_PRODUCTS = {
  beet:   { name: "BeetRoot – บีทรูท", price: 89 },
  matcha: { name: "Matcha – มัทฉะ", price: 89 },
  butter: { name: "Butterfly Pea – อัญชัน", price: 89 },
  mix:    { name: "ซองรวม 3 รส (12 ชิ้น)", price: 189 },
};
const CANONICAL_SHIPPING = {
  regular: { name: "ไปรษณีย์ธรรมดา", price: 50 },
  ems:     { name: "EMS ด่วนพิเศษ", price: 60 },
  flash:   { name: "Flash Express", price: 50 },
  kerry:   { name: "Kerry Express", price: 70 },
};
const MAX_QTY_PER_ITEM = 50;

function validateAndPriceOrder(items, shipping) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "กรุณาเลือกสินค้าอย่างน้อย 1 รายการ" };
  }
  const verifiedItems = [];
  for (const raw of items) {
    const canonical = CANONICAL_PRODUCTS[raw && raw.id];
    if (!canonical) return { error: `ไม่พบสินค้ารหัส "${raw && raw.id}" ในระบบ` };
    const qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY_PER_ITEM) {
      return { error: `จำนวนสินค้า "${canonical.name}" ไม่ถูกต้อง` };
    }
    verifiedItems.push({ id: raw.id, name: canonical.name, price: canonical.price, qty });
  }
  const canonicalShipping = CANONICAL_SHIPPING[shipping && shipping.id];
  if (!canonicalShipping) return { error: "กรุณาเลือกวิธีจัดส่งให้ถูกต้อง" };

  const itemsTotal = verifiedItems.reduce((s, it) => s + it.price * it.qty, 0);
  return {
    items: verifiedItems,
    shipping: { id: shipping.id, name: canonicalShipping.name, price: canonicalShipping.price },
    grandTotal: itemsTotal + canonicalShipping.price,
  };
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method === "GET") {
    const { roundId, userId } = req.query;
    if (!roundId) { res.status(400).json({ error: "roundId required" }); return; }
    const list = await getWaitlist(roundId);
    if (userId) {
      // ลูกค้าเช็คลำดับคิวของตัวเอง — ไม่ต้องมีรหัส (เห็นแค่ลำดับ ไม่เห็นข้อมูลคนอื่น)
      const position = list.findIndex((w) => w.userId === userId);
      res.status(200).json({
        total: list.length,
        yourPosition: position >= 0 ? position + 1 : null, // 1-indexed สำหรับแสดงผลลูกค้า
      });
      return;
    }
    // 🔒 โหมดดูคิวสำรองทั้งหมด (มีชื่อ/เบอร์/ที่อยู่ทุกคน) — แอดมินเท่านั้น
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }
    logAdminAction(session.name, "ดูคิวสำรองทั้งหมด", { roundId });
    res.status(200).json({ total: list.length, waitlist: list });
    return;
  }

  if (req.method === "POST") {
    // ── ลูกค้าต่อคิวสำรองตอนรอบเต็ม ──
    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const { roundId, userId, name, phone, addr, email, birth, items, shipping } = body;
    if (!roundId || !userId || !name) {
      res.status(400).json({ error: "roundId, userId, name required" });
      return;
    }
    if (String(name).length > 100) { res.status(400).json({ error: "ชื่อยาวเกินไป" }); return; }
    if (addr && String(addr).length > 500) { res.status(400).json({ error: "ที่อยู่ยาวเกินไป" }); return; }

    // ตรวจสอบและคำนวณราคาจริงฝั่งเซิร์ฟเวอร์ (ไม่เชื่อราคาจากลูกค้า เหมือน order.js)
    const priced = validateAndPriceOrder(items, shipping);
    if (priced.error) { res.status(400).json({ error: priced.error }); return; }

    const list = await getWaitlist(roundId);
    if (list.some((w) => w.userId === userId)) {
      res.status(200).json({ ok: true, alreadyOnList: true, position: list.findIndex((w) => w.userId === userId) + 1 });
      return;
    }

    // จำกัดขนาดคิวสำรองสูงสุดต่อรอบ (กันสแปม/บอทยิงต่อคิวรัวๆ จนระบบข้อมูลบวม)
    const MAX_WAITLIST_PER_ROUND = 100;
    if (list.length >= MAX_WAITLIST_PER_ROUND) {
      res.status(409).json({ error: "คิวสำรองของรอบนี้เต็มแล้วค่ะ กรุณาลองรอบอื่นนะคะ" });
      return;
    }

    const entry = {
      userId,
      name: String(name).slice(0, 100),
      phone: String(phone || "").slice(0, 30),
      addr: String(addr || "").slice(0, 500),
      email: String(email || "").slice(0, 200),
      birth: String(birth || "").slice(0, 20),
      items: priced.items,
      shipping: priced.shipping,
      grandTotal: priced.grandTotal,
      joinedAt: new Date().toISOString(),
    };
    list.push(entry);
    await saveWaitlist(roundId, list);

    res.status(201).json({ ok: true, position: list.length, message: "ต่อคิวสำรองสำเร็จ" });
    return;
  }

  if (req.method === "DELETE") {
    // ── ลูกค้าออกจากคิวสำรองเอง (เปลี่ยนใจ) ──
    const { roundId, userId } = req.query;
    if (!roundId || !userId) { res.status(400).json({ error: "roundId and userId required" }); return; }
    let list = await getWaitlist(roundId);
    list = list.filter((w) => w.userId !== userId);
    await saveWaitlist(roundId, list);
    res.status(200).json({ ok: true, message: "ออกจากคิวสำรองแล้ว" });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};
