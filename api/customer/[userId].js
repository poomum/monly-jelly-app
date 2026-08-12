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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { userId } = req.query;

  if (!userId) {
    res.status(400).json({ error: "missing userId" });
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
