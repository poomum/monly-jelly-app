// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Commerce Extra (รวม 3 endpoint เข้าไฟล์เดียว)
// วางไฟล์นี้ที่: /api/commerce-extra.js
//
// รวมไฟล์นี้เพื่อลดจำนวน Serverless Functions ให้อยู่ในลิมิตของ
// Vercel Hobby plan (สูงสุด 12 ฟังก์ชัน/deployment) — URL เดิมที่
// หน้าเว็บเรียกใช้ (/api/tracking-pool, /api/waitlist, /api/coupons)
// ยังใช้งานได้เหมือนเดิมทุกอย่าง ผ่าน rewrites ใน vercel.json
//
//   /api/tracking-pool  → /api/commerce-extra?resource=tracking-pool
//   /api/waitlist       → /api/commerce-extra?resource=waitlist
//   /api/coupons        → /api/commerce-extra?resource=coupons
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
const { getAllPromotions, checkPromoValidity, calcDiscount } = require("../lib/promotions");

// ═══════════════════════════════════════════════════════════════
// resource=tracking-pool (เดิม: api/tracking-pool.js)
// ═══════════════════════════════════════════════════════════════
const CARRIERS = ["regular", "ems", "flash", "kerry"];
const poolKey = (carrier) => `tracking:pool:${carrier}`;

async function handleTrackingPool(req, res) {
  const adminSession = await validateSession(req.headers["x-admin-session"]);
  if (!adminSession) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }

  if (req.method === "GET") {
    const { carrier } = req.query;
    if (carrier) {
      if (!CARRIERS.includes(carrier)) {
        res.status(400).json({ ok: false, error: `carrier ต้องเป็นหนึ่งใน: ${CARRIERS.join(", ")}` });
        return;
      }
      const numbers = (await kv.lrange(poolKey(carrier), 0, -1)) || [];
      res.status(200).json({ ok: true, carrier, count: numbers.length, numbers });
      return;
    }
    const summary = {};
    for (const c of CARRIERS) {
      const numbers = (await kv.lrange(poolKey(c), 0, -1)) || [];
      summary[c] = numbers.length;
    }
    res.status(200).json({ ok: true, summary });
    return;
  }

  if (req.method === "DELETE") {
    const { carrier } = req.query;
    if (!carrier || !CARRIERS.includes(carrier)) {
      res.status(400).json({ ok: false, error: `ต้องระบุ ?carrier= หนึ่งใน: ${CARRIERS.join(", ")}` });
      return;
    }
    await kv.del(poolKey(carrier));
    logAdminAction(adminSession.name, `ล้างคลังเลขพัสดุ (${carrier})`, { carrier });
    res.status(200).json({ ok: true, cleared: true, carrier });
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const { carrier, numbers: rawNumbers, text } = body;
    if (!carrier || !CARRIERS.includes(carrier)) {
      res.status(400).json({ ok: false, error: `ต้องระบุ carrier เป็นหนึ่งใน: ${CARRIERS.join(", ")}` });
      return;
    }

    let numbers = rawNumbers;
    if (!numbers && text) {
      numbers = String(text).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
      res.status(400).json({ ok: false, error: "ต้องระบุ numbers (array) หรือ text (วางเป็นก้อน แยกบรรทัดละเลข)" });
      return;
    }

    const cleaned = [...new Set(numbers.map((n) => String(n).trim()).filter(Boolean))];
    const existingPool = (await kv.lrange(poolKey(carrier), 0, -1)) || [];
    const existingSet = new Set(existingPool);
    const toAdd = cleaned.filter((n) => !existingSet.has(n));
    const skippedDuplicates = cleaned.length - toAdd.length;

    if (toAdd.length > 0) {
      await kv.rpush(poolKey(carrier), ...toAdd);
    }

    logAdminAction(adminSession.name, `เติมเลขพัสดุ (${carrier})`, {
      carrier, added: toAdd.length, skippedDuplicates,
    });

    res.status(200).json({
      ok: true, carrier, added: toAdd.length, skippedDuplicates,
      totalInPool: existingPool.length + toAdd.length,
    });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
}

// ═══════════════════════════════════════════════════════════════
// resource=waitlist (เดิม: api/waitlist.js)
// ═══════════════════════════════════════════════════════════════
async function getWaitlist(roundId) {
  const data = await kv.get(`waitlist:${roundId}`);
  if (!data) return [];
  return typeof data === "string" ? JSON.parse(data) : data;
}
async function saveWaitlist(roundId, list) {
  await kv.set(`waitlist:${roundId}`, JSON.stringify(list));
}

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

async function handleWaitlist(req, res) {
  if (req.method === "GET") {
    const { roundId, userId } = req.query;
    if (!roundId) { res.status(400).json({ error: "roundId required" }); return; }
    const list = await getWaitlist(roundId);
    if (userId) {
      const position = list.findIndex((w) => w.userId === userId);
      res.status(200).json({
        total: list.length,
        yourPosition: position >= 0 ? position + 1 : null,
      });
      return;
    }
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
    const body = req.body || {};
    const { roundId, userId, name, phone, addr, email, birth, items, shipping, promoCode } = body;
    // userId ไม่บังคับ (เผื่อ LIFF โหลดพลาดชั่วคราว หรือลูกค้าเปิดนอกแอป LINE)
    // เหมือนกับ /api/order ที่ยอมให้ userId เป็น null ได้ — แค่จะไม่มีการแจ้งเตือนอัตโนมัติ
    // ทาง LINE ตอนเลื่อนคิวขึ้นมา (ต้องเช็คสถานะเองผ่านหน้าติดตามออเดอร์แทน)
    if (!roundId || !name) {
      res.status(400).json({ error: "roundId, name required" });
      return;
    }
    if (String(name).length > 100) { res.status(400).json({ error: "ชื่อยาวเกินไป" }); return; }
    if (addr && String(addr).length > 500) { res.status(400).json({ error: "ที่อยู่ยาวเกินไป" }); return; }

    const priced = validateAndPriceOrder(items, shipping);
    if (priced.error) { res.status(400).json({ error: priced.error }); return; }

    // ── ถ้าใส่โค้ดส่วนลดไว้ตอนต่อคิวสำรอง ให้ตรวจสอบ+คำนวณส่วนลดเก็บไว้ด้วย
    //    (เหมือนตอนสั่งซื้อจริง) — ไม่บังคับต้องมี ถ้าไม่ใส่มาก็ข้ามส่วนนี้ไปเฉยๆ ──
    let waitlistDiscount = 0;
    let appliedPromoCode = null;
    if (promoCode && String(promoCode).trim()) {
      const codeUpper = String(promoCode).toUpperCase().trim();
      const promotions = await getAllPromotions();
      const promo = promotions.find((p) => p.code === codeUpper);
      const check = checkPromoValidity(promo, priced.items.reduce((s, i) => s + i.price * i.qty, 0), userId || null);
      if (check.valid) {
        waitlistDiscount = calcDiscount(promo, priced.items.reduce((s, i) => s + i.price * i.qty, 0), priced.shipping.price);
        appliedPromoCode = codeUpper;
      }
      // ถ้าโค้ดใช้ไม่ได้ (หมดอายุ/ไม่พบ) ก็แค่ไม่ใส่ส่วนลดให้ ไม่ error ออกไป เพราะลูกค้า
      // ยังต่อคิวสำรองต่อได้ตามปกติ แค่ไม่ได้ส่วนลด (จะได้ไม่บล็อกการต่อคิวเพราะโค้ดมีปัญหา)
    }

    const list = await getWaitlist(roundId);
    // เช็คคิวซ้ำได้เฉพาะตอนมี userId เท่านั้น (ไม่มี userId ก็ไม่มีทางรู้ว่าเป็นคนเดิมไหม)
    if (userId && list.some((w) => w.userId === userId)) {
      res.status(200).json({ ok: true, alreadyOnList: true, position: list.findIndex((w) => w.userId === userId) + 1 });
      return;
    }

    const MAX_WAITLIST_PER_ROUND = 100;
    if (list.length >= MAX_WAITLIST_PER_ROUND) {
      res.status(409).json({ error: "คิวสำรองของรอบนี้เต็มแล้วค่ะ กรุณาลองรอบอื่นนะคะ" });
      return;
    }

    const entry = {
      userId: userId || null,
      name: String(name).slice(0, 100),
      phone: String(phone || "").slice(0, 30),
      addr: String(addr || "").slice(0, 500),
      email: String(email || "").slice(0, 200),
      birth: String(birth || "").slice(0, 20),
      items: priced.items,
      shipping: priced.shipping,
      promoCode: appliedPromoCode,
      discount: waitlistDiscount,
      grandTotal: priced.grandTotal - waitlistDiscount,
      joinedAt: new Date().toISOString(),
    };
    list.push(entry);
    await saveWaitlist(roundId, list);

    res.status(201).json({ ok: true, position: list.length, message: "ต่อคิวสำรองสำเร็จ" });
    return;
  }

  if (req.method === "DELETE") {
    const { roundId, userId } = req.query;
    if (!roundId || !userId) { res.status(400).json({ error: "roundId and userId required" }); return; }
    let list = await getWaitlist(roundId);
    list = list.filter((w) => w.userId !== userId);
    await saveWaitlist(roundId, list);
    res.status(200).json({ ok: true, message: "ออกจากคิวสำรองแล้ว" });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
}

// ═══════════════════════════════════════════════════════════════
// resource=coupons (เดิม: api/coupons.js)
// ═══════════════════════════════════════════════════════════════
async function handleCoupons(req, res) {
  try {
    if (req.method === "GET") {
      const { userId } = req.query;
      if (!userId) { res.status(400).json({ error: "userId required" }); return; }
      const coupons = await kv.get(`coupons:${userId}`);
      const list = coupons ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons) : [];
      res.status(200).json({ coupons: list });
      return;
    }

    if (req.method === "POST") {
      const { userId, theme, greeting, profileImg } = req.body || {};
      if (!userId || !theme || !greeting) {
        res.status(400).json({ error: "userId, theme, greeting required" });
        return;
      }
      const coupons = await kv.get(`coupons:${userId}`);
      const list = coupons ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons) : [];
      const coupon = {
        id: `cpn-${Date.now()}`,
        userId, theme, greeting,
        profileImg: profileImg || "",
        createdAt: new Date().toISOString(),
        usedAt: null,
        usedInOrderId: null,
      };
      list.push(coupon);
      await kv.set(`coupons:${userId}`, JSON.stringify(list));
      res.status(201).json({ coupon, message: "Coupon created" });
      return;
    }

    if (req.method === "PATCH") {
      const { userId, couponId, orderId } = req.body || {};
      if (!userId || !couponId || !orderId) {
        res.status(400).json({ error: "userId, couponId, orderId required" });
        return;
      }
      const coupons = await kv.get(`coupons:${userId}`);
      let list = coupons ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons) : [];
      list = list.map((c) =>
        c.id === couponId ? { ...c, usedAt: new Date().toISOString(), usedInOrderId: orderId } : c
      );
      await kv.set(`coupons:${userId}`, JSON.stringify(list));
      res.status(200).json({ message: "Coupon marked as used" });
      return;
    }

    if (req.method === "DELETE") {
      const { userId, couponId } = req.query;
      if (!userId || !couponId) {
        res.status(400).json({ error: "userId and couponId required" });
        return;
      }
      const coupons = await kv.get(`coupons:${userId}`);
      let list = coupons ? (typeof coupons === "string" ? JSON.parse(coupons) : coupons) : [];
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

// ═══════════════════════════════════════════════════════════════
// Dispatch หลัก
// ═══════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { resource } = req.query;

  if (resource === "tracking-pool") { await handleTrackingPool(req, res); return; }
  if (resource === "waitlist") { await handleWaitlist(req, res); return; }
  if (resource === "coupons") { await handleCoupons(req, res); return; }

  res.status(400).json({ error: "ต้องระบุ ?resource=tracking-pool, waitlist, หรือ coupons" });
};

// ทุก resource ในไฟล์นี้ใช้ bodyParser: true (Vercel parse JSON ให้อัตโนมัติ
// ผ่าน req.body) เหมือนกันหมด — ไม่มี resource ไหนต้องอ่าน raw body เอง
// เพราะไม่มีการตรวจสอบ HMAC signature ในไฟล์นี้เลย
module.exports.config = { api: { bodyParser: true } };
