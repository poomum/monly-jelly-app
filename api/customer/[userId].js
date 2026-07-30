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
    const customer = await kv.get(`customer:${userId}`);
    if (!customer) {
      res.status(404).json({ error: "not found" });
      return;
    }
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

    const existing = (await kv.get(`customer:${userId}`)) || { userId };
    const { phone, addr, name, email, birth, birthday, avatar, couponTheme, couponGreeting } = payload;
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
      updatedAt: new Date().toISOString(),
    };
    await kv.set(`customer:${userId}`, JSON.stringify(updated));
    await kv.sadd("customers:index", userId);
    res.status(200).json(updated);
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};

module.exports.config = {
  api: { bodyParser: false },
};
