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

// ตรวจสอบว่าเป็นรูปภาพ base64 จริง (กัน XSS ถ้ามีคนพยายามยัด HTML/script
// เข้ามาแทนรูปภาพผ่านการเรียก API ตรงๆ โดยไม่ผ่านหน้าเว็บ) + จำกัดขนาด
// ไม่ให้ใหญ่เกินไป (กันฐานข้อมูลบวมเมื่อลูกค้าอัปโหลดรูปใหญ่มากๆ)
const MAX_AVATAR_LENGTH = 700_000; // ~500KB รูปจริง (base64 ใหญ่กว่าไฟล์จริงราว 33%)
function isValidAvatar(avatar) {
  if (typeof avatar !== "string") return false;
  if (avatar.length > MAX_AVATAR_LENGTH) return false;
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatar);
}

function isValidBirthday(birthday) {
  return typeof birthday === "string" && /^\d{4}-\d{2}-\d{2}$/.test(birthday);
}

const { validateSession, logAdminAction } = require("../../lib/adminAuth");
const { addLoyaltyPoint, buildLoyaltyRewardMessage, getAllPromotions, savePromotions, generateUniquePromoCode } = require("../../lib/promotions");

async function linePush(userId, messages, accessToken) {
  if (!userId || !accessToken) return false;
  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`LINE push failed: HTTP ${resp.status} — ${errText}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("LINE push failed (network error):", e);
    return false;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { userId } = req.query;

  if (!userId) {
    res.status(400).json({ error: "missing userId" });
    return;
  }

  // ── แอดมินให้แต้มสะสม "พลังงานชีวิต" ย้อนหลังด้วยมือ ──
  // ใช้ตอนลูกค้าจ่ายเงินสำเร็จจริงแต่ระบบพลาดไม่ได้เพิ่มแต้มให้อัตโนมัติ (เช่น
  // ตอนที่ยังมีบั๊กอยู่ก่อนหน้านี้) แอดมินสามารถกดให้แต้มชดเชยย้อนหลังได้เอง
  if (req.method === "POST") {
    const token = req.headers["x-admin-session"];
    const session = await validateSession(token);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }

    let payload = {};
    try {
      const raw = await getRawBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      res.status(400).json({ error: "invalid json body" });
      return;
    }

    if (payload.action === "award_loyalty_point") {
      const result = await addLoyaltyPoint(userId);
      if (!result) {
        res.status(500).json({ error: "ให้แต้มไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
        return;
      }
      if (result.rewardCreated && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
        const msg = buildLoyaltyRewardMessage(result.rewardCreated, process.env.LIFF_ID);
        linePush(userId, [{ type: "text", text: msg }], process.env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {});
      }
      logAdminAction(session.name, "ให้แต้มสะสมย้อนหลัง", { userId, newPoints: result.points, rewardCreated: !!result.rewardCreated });
      res.status(200).json({ ok: true, ...result });
      return;
    }

    // ── สร้างส่วนลดเฉพาะรายบุคคล (แอดมินกำหนดจำนวนเงิน/วันหมดอายุเอง) ──
    // ใช้ตอนอยากมอบส่วนลดพิเศษให้ลูกค้าคนใดคนหนึ่งเป็นกรณีพิเศษ (เช่น ขอโทษที่
    // สินค้ามีปัญหา, ลูกค้าประจำที่อยากดูแลเป็นพิเศษ ฯลฯ) ล็อกให้ใช้ได้เฉพาะ
    // เจ้าของคนนี้เท่านั้น เหมือนคูปองวันเกิด/รางวัลสะสมแต้มทุกอย่าง
    if (payload.action === "create_personal_discount") {
      const discountAmount = Number(payload.discount);
      const MAX_VALID_DAYS = 90; // สูงสุด 3 เดือน ห้ามเกินนี้ไม่ว่าแอดมินจะกรอกอะไรมาก็ตาม
      const validDays = Math.min(Number(payload.validDays) || 30, MAX_VALID_DAYS);
      if (!discountAmount || discountAmount <= 0) {
        res.status(400).json({ error: "กรุณาระบุจำนวนส่วนลดให้ถูกต้อง (มากกว่า 0)" });
        return;
      }

      const customerRaw = await kv.get(`customer:${userId}`);
      const customer = customerRaw ? (typeof customerRaw === "string" ? JSON.parse(customerRaw) : customerRaw) : { userId };

      const promoCode = await generateUniquePromoCode("VIP");
      const expiresDate = new Date();
      expiresDate.setDate(expiresDate.getDate() + validDays);
      const expiresAtISO = expiresDate.toISOString();

      const promotions = await getAllPromotions();
      promotions.push({
        code: promoCode,
        type: "fixed",
        value: discountAmount,
        startDate: null,
        endDate: expiresAtISO.slice(0, 10),
        active: true,
        restrictedToUserId: userId,
        maxUses: 1,
        createdAt: new Date().toISOString(),
        createdBy: `แอดมิน: ${session.name}`,
      });
      await savePromotions(promotions);

      // บันทึกลงรายการคูปองของลูกค้าด้วย ให้เห็นในหน้า "คูปองของฉัน"
      const couponsRaw = await kv.get(`coupons:${userId}`);
      const coupons = couponsRaw ? (typeof couponsRaw === "string" ? JSON.parse(couponsRaw) : couponsRaw) : [];
      coupons.push({
        id: `cpn-personal-${userId}-${Date.now()}`,
        userId,
        source: "personal", // แยกจาก birthday/loyalty/game ให้ชัดเจน
        discount: discountAmount,
        code: promoCode,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAtISO,
        used: false,
        note: payload.note || "",
      });
      await kv.set(`coupons:${userId}`, coupons);

      logAdminAction(session.name, "สร้างส่วนลดเฉพาะบุคคล", { userId, discount: discountAmount, code: promoCode, validDays });

      // แจ้งลูกค้าทาง LINE (ถ้ามี access token)
      if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
        const liffId = process.env.LIFF_ID;
        const claimLink = liffId ? `https://liff.line.me/${liffId}?rewardCode=${encodeURIComponent(promoCode)}&tab=queue` : null;
        const claimLine = claimLink
          ? `👇 กดลิงก์นี้เมื่อพร้อมสั่งซื้อ ระบบจะเติมโค้ดลงช่องส่วนลดให้อัตโนมัติเลย:\n${claimLink}\n\n`
          : "";
        const text =
          `🎁 ทางร้านมีส่วนลดพิเศษมอบให้คุณ ${customer.name || ""} ค่ะ!\n\n` +
          `💚 ส่วนลด ${discountAmount} บาท\n` +
          `🎟️ โค้ด: ${promoCode}\n` +
          `⏳ ใช้ได้ภายใน ${validDays} วัน (หมดอายุ ${expiresAtISO.slice(0, 10)})\n\n` +
          `📌 เก็บโค้ดนี้ไว้ได้เลยค่ะ ไม่ต้องรีบใช้ตอนนี้ก็ได้ — ใช้ได้ทุกเมื่อภายในระยะเวลาที่กำหนด ไม่ว่าจะสั่งซื้อวันไหนก็ตาม\n\n` +
          `📝 วิธีใช้:\n` +
          `1. เลือกสินค้า + รอบที่ต้องการตามปกติ\n` +
          `2. ถึงหน้าชำระเงิน จะมีช่อง "โค้ดส่วนลด"\n` +
          `3. พิมพ์โค้ด ${promoCode} ลงไป แล้วกดใช้โค้ด (หรือกดลิงก์ด้านล่างให้ระบบเติมให้อัตโนมัติเลยก็ได้)\n` +
          `4. ระบบจะหักส่วนลดออกจากยอดที่ต้องชำระให้ทันที\n\n` +
          claimLine +
          `ขอบคุณที่อุดหนุนร้านเรานะคะ 💚`;
        linePush(userId, [{ type: "text", text }], process.env.LINE_CHANNEL_ACCESS_TOKEN).catch(() => {});
      }

      res.status(200).json({ ok: true, code: promoCode, discount: discountAmount, expiresAt: expiresAtISO });
      return;
    }

    res.status(400).json({ error: "ไม่รู้จัก action นี้" });
    return;
  }

  if (req.method === "GET") {
    const raw = await kv.get(`customer:${userId}`);
    if (!raw) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // ป้องกันเคสที่ค่าที่เก็บไว้เผลอถูก stringify มาก่อน (เช่นจากบั๊กเก่า) — แกะออกให้เป็น object เสมอ
    const customer = typeof raw === "string" ? JSON.parse(raw) : raw;
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

    // ── ตรวจสอบรูปแบบข้อมูลก่อนบันทึกเสมอ (กัน XSS + ข้อมูลขยะ/ผิดปกติ) ──
    if (payload.avatar && !isValidAvatar(payload.avatar)) {
      res.status(400).json({ error: "รูปภาพไม่ถูกต้องหรือมีขนาดใหญ่เกินไป (จำกัดไม่เกิน ~500KB)" });
      return;
    }
    if (payload.birthday && !isValidBirthday(payload.birthday)) {
      res.status(400).json({ error: "รูปแบบวันเกิดไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)" });
      return;
    }
    // จำกัดความยาวข้อความทุกฟิลด์ กันข้อมูลขยะ/สแปมยัดข้อความยาวเกินจำเป็น
    const capLen = (v, max) => (typeof v === "string" ? v.slice(0, max) : v);

    const existingRaw = await kv.get(`customer:${userId}`);
    // ป้องกันเคสที่ค่าที่เก็บไว้เผลอถูก stringify มาก่อน (เช่นจากบั๊กเก่า) — แกะออกให้เป็น object เสมอ
    // ก่อนจะเอามา spread ต่อ ไม่งั้นถ้า existing เป็น string ดิบๆ จะถูก spread เป็น key ตัวเลขทีละตัวอักษร
    // แล้วข้อมูลโปรไฟล์จะพังทันทีตั้งแต่การบันทึกครั้งที่สองเป็นต้นไป
    const existing = existingRaw ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) : { userId };
    const { phone, addr, name, email, birth, birthday, avatar, couponTheme, couponGreeting, couponFontSize, couponTextColor } = payload;
    const VALID_FONT_SIZES = ["small", "medium", "large"];
    const isValidHexColor = (c) => typeof c === "string" && /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(c.trim());
    const updated = {
      ...existing,
      userId,
      ...(phone ? { phone: capLen(String(phone), 30) } : {}),
      ...(addr ? { addr: capLen(String(addr), 500) } : {}),
      ...(name ? { name: capLen(String(name), 100) } : {}),
      ...(email ? { email: capLen(String(email), 200) } : {}),
      ...(birth ? { birth: capLen(String(birth), 20) } : {}),
      ...(birthday ? { birthday } : {}),
      ...(avatar ? { avatar } : {}),
      ...(couponTheme ? { couponTheme: capLen(String(couponTheme), 30) } : {}),
      ...(couponGreeting ? { couponGreeting: capLen(String(couponGreeting), 100) } : {}),
      // เช็คชนิดข้อมูลให้เข้มงวด กัน XSS/ค่าประหลาดหลุดเข้าไปเป็น inline style ตอนแสดงผลคูปอง
      ...(VALID_FONT_SIZES.includes(couponFontSize) ? { couponFontSize } : {}),
      ...(couponTextColor === "" ? { couponTextColor: "" } : isValidHexColor(couponTextColor) ? { couponTextColor: couponTextColor.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    // เก็บเป็น object ตรงๆ (ไม่ JSON.stringify เอง) เพราะ @vercel/kv serialize/deserialize
    // ให้อัตโนมัติอยู่แล้ว — ถ้า stringify ซ้อนเองจะกลายเป็นเก็บ "ข้อความ JSON" แทนที่จะเป็น
    // object จริง แล้วรอบบันทึกถัดไปจะอ่านค่าคืนมาเป็น string ทำให้ข้อมูลพังสะสมทุกครั้งที่แก้ไข
    await kv.set(`customer:${userId}`, updated);
    await kv.sadd("customers:index", userId);
    res.status(200).json(updated);
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};

module.exports.config = {
  api: { bodyParser: false },
};
