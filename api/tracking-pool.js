// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Tracking Number Pool แยกตามขนส่ง (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/tracking-pool.js
//
// รองรับขนส่ง 4 เจ้า (ตรงกับตัวเลือกจัดส่งในหน้าเว็บ):
//   regular = ไปรษณีย์ธรรมดา, ems = EMS, flash = Flash Express, kerry = Kerry Express
//
//   POST /api/tracking-pool   { carrier: "kerry", numbers: ["KEX1111","KEX2222", ...] }
//        → เติมเลขพัสดุเข้า "คลัง" ของขนส่งนั้นๆ ทีเดียวหลายเลข (กันซ้ำ + กันเลขว่าง)
//        → หรือส่ง { carrier: "kerry", text: "เลข1\nเลข2\nเลข3" } วางเป็นก้อนก็ได้ (แยกบรรทัด/คอมม่า)
//
//   GET  /api/tracking-pool
//        → ดูจำนวนเลขที่เหลือของ "ทุกขนส่ง" พร้อมกัน (ไว้เช็คว่าเจ้าไหนใกล้หมด)
//   GET  /api/tracking-pool?carrier=kerry
//        → ดูเฉพาะขนส่งเจ้าเดียว
//
//   DELETE /api/tracking-pool?carrier=kerry
//        → ล้างคลังของขนส่งเจ้านั้น (เผื่อใส่ผิดชุด)
//
// เมื่อออเดอร์ถูกเปลี่ยนสถานะเป็น "shipped" โดยไม่ได้ระบุเลขแทร็กกิ้งเอง
// api/order.js จะดูว่าลูกค้าเลือกขนส่งอะไรตอนสั่งซื้อ แล้วดึงเลขถัดไปจากคลังของขนส่งนั้น
// ให้อัตโนมัติ (แบบ FIFO เข้าก่อนออกก่อน)
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

// ── ระบบ Login แอดมิน (session-based) — ใช้ไฟล์กลางร่วมกับ api อื่นๆ ──
const { validateSession, logAdminAction } = require("../lib/adminAuth");

const CARRIERS = ["regular", "ems", "flash", "kerry"];
const poolKey = (carrier) => `tracking:pool:${carrier}`;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const adminSession = await validateSession(req.headers["x-admin-session"]);
  if (!adminSession) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }

  // ── ดูจำนวนเลขที่เหลือในคลัง (ทุกขนส่ง หรือเจ้าเดียว) ──
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
    // ไม่ระบุ carrier → สรุปทุกเจ้าให้ดูรวด
    const summary = {};
    for (const c of CARRIERS) {
      const numbers = (await kv.lrange(poolKey(c), 0, -1)) || [];
      summary[c] = numbers.length;
    }
    res.status(200).json({ ok: true, summary });
    return;
  }

  // ── ล้างคลังของขนส่งเจ้านั้น ──
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

  // ── เติมเลขพัสดุเข้าคลังของขนส่งเจ้านั้น ──
  if (req.method === "POST") {
    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ ok: false, error: "invalid json" }); return; }

    const { carrier, numbers: rawNumbers, text } = body;
    if (!carrier || !CARRIERS.includes(carrier)) {
      res.status(400).json({ ok: false, error: `ต้องระบุ carrier เป็นหนึ่งใน: ${CARRIERS.join(", ")}` });
      return;
    }

    let numbers = rawNumbers;
    // รองรับทั้งแบบ array และแบบ paste เป็นก้อนข้อความ (แยกบรรทัด/comma)
    if (!numbers && text) {
      numbers = String(text)
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
      res.status(400).json({ ok: false, error: "ต้องระบุ numbers (array) หรือ text (วางเป็นก้อน แยกบรรทัดละเลข)" });
      return;
    }

    // ทำความสะอาด: ตัดช่องว่าง, เอาตัวซ้ำในชุดเดียวกันออก
    const cleaned = [...new Set(numbers.map((n) => String(n).trim()).filter(Boolean))];

    // กันเลขที่เคยอยู่ในคลังของขนส่งเจ้านี้อยู่แล้ว ไม่ให้เข้าซ้ำ
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
      ok: true,
      carrier,
      added: toAdd.length,
      skippedDuplicates,
      totalInPool: existingPool.length + toAdd.length,
    });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};

