// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Production Rounds API (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/rounds.js
//   GET   /api/rounds          → รายการรอบผลิตทั้งหมด + ที่นั่งว่าง
//   POST  /api/rounds          → (แอดมิน) เพิ่ม/แก้รอบ  body:{rounds:[...]}
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

// ── ระบบสร้างรอบ "ทุกวันศุกร์" อัตโนมัติ ไม่มีวันหมด ──────────────
const THAI_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

function formatThaiDate(d) {
  const day = d.getDate();
  const month = THAI_MONTHS[d.getMonth()];
  const buddhistYear = d.getFullYear() + 543;
  return `${day} ${month} ${buddhistYear}`;
}

function dateKey(d) {
  // ใช้เป็น id ที่ไม่ซ้ำ อ่านง่าย เรียงลำดับได้ เช่น r-2026-07-31
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `r-${y}-${m}-${day}`;
}

// วันเปิดรับพรีออเดอร์รอบแรก (ปรับตรงนี้ถ้าอยากเปลี่ยนวันเริ่มในอนาคต)
// ⚠️ ใช้ new Date(year, monthIndex, day) แบบนี้เท่านั้น ห้ามใช้ ISO string + timezone offset
//    เพราะ Vercel รันเซิร์ฟเวอร์เวลา UTC ถ้าใช้ "+07:00" จะคำนวณวันที่เพี้ยนไป 1 วัน
const FIRST_FRIDAY = new Date(2026, 6, 31); // เดือนนับจาก 0 → 6 = กรกฎาคม, วันที่ 31
// ค่าเริ่มต้น "ลิมิตออเดอร์ต่อวัน/ต่อรอบ" สำหรับรอบใหม่ที่ระบบสร้างให้อัตโนมัติ
// เปลี่ยนได้ผ่านหน้า rounds-admin.html (บันทึกไว้ใน KV ไม่ต้องแก้โค้ด)
const FALLBACK_DEFAULT_CAPACITY = 10;
// ── ระบบ Login แอดมิน (session-based) — ใช้ไฟล์กลางร่วมกับ api อื่นๆ ──
const { validateSession, logAdminAction } = require("../lib/adminAuth");

async function getDefaultCapacity() {
  const saved = await kv.get("settings:defaultCapacity");
  const n = Number(saved);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_DEFAULT_CAPACITY;
}

// สร้างรายชื่อ "วันศุกร์ถัดไป" จำนวน n วัน นับต่อจาก afterDate (ไม่รวม afterDate เอง)
async function nextFridaysAfter(afterDate, n) {
  const capacity = await getDefaultCapacity();
  const list = [];
  const d = new Date(afterDate);
  d.setDate(d.getDate() + 1); // เริ่มนับวันถัดไป
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1); // เดินไปจนถึงวันศุกร์
  for (let i = 0; i < n; i++) {
    list.push({
      id: dateKey(d),
      date: formatThaiDate(d),
      capacity,
      booked: 0,
    });
    d.setDate(d.getDate() + 7);
  }
  return list;
}

// รอบเริ่มต้น (ใช้ครั้งแรกถ้ายังไม่เคยตั้งค่าใน KV) — 31 ก.ค. + อีก 11 ศุกร์ถัดไป (รวม 12 สัปดาห์ ~3 เดือน)
async function buildInitialRounds() {
  const capacity = await getDefaultCapacity();
  const first = {
    id: dateKey(FIRST_FRIDAY),
    date: formatThaiDate(FIRST_FRIDAY),
    capacity,
    booked: 0,
  };
  const rest = await nextFridaysAfter(FIRST_FRIDAY, 5);
  return [first, ...rest];
}

// เติมรอบวันศุกร์ใหม่ให้อัตโนมัติ ถ้าเหลือรอบที่ "ยังไม่ถึงวัน" น้อยกว่า MIN_FUTURE
const MIN_FUTURE = 2;
async function topUpFutureFridays(rounds) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const futureCount = rounds.filter((r) => parseRoundDateLoose(r) >= today).length;
  if (futureCount >= MIN_FUTURE) return rounds;

  // หาวันที่ล่าสุดในลิสต์ปัจจุบัน (หรือวันนี้ ถ้าลิสต์ว่าง) แล้วต่อวันศุกร์ใหม่จากตรงนั้น
  const lastDate = rounds.length
    ? rounds.reduce((max, r) => {
        const d = parseRoundDateLoose(r);
        return d > max ? d : max;
      }, today)
    : today;

  const need = MIN_FUTURE - futureCount + 2; // เติมเผื่อล่วงหน้าอีกนิด กันเช็คถี่เกินไป (ปรับให้เข้ากับเป้าหมาย ~6 รอบ)
  const additions = await nextFridaysAfter(lastDate, need);
  return [...rounds, ...additions];
}

// พยายามอ่านวันที่จาก id แบบ r-YYYY-MM-DD ก่อน (แม่นยำสุด) ถ้าไม่ได้ค่อย fallback
function parseRoundDateLoose(r) {
  if (r.id && /^r-\d{4}-\d{2}-\d{2}$/.test(r.id)) {
    const [, y, m, d] = r.id.match(/^r-(\d{4})-(\d{2})-(\d{2})$/);
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  return new Date(0); // รอบเก่าที่ไม่รู้จักรูปแบบ ถือว่าผ่านไปแล้ว
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method === "GET") {
    let rounds = await kv.get("rounds:all");
    if (!rounds || (Array.isArray(rounds) && rounds.length === 0)) {
      rounds = await buildInitialRounds();
      await kv.set("rounds:all", rounds);
    } else {
      // เติมวันศุกร์ใหม่อัตโนมัติถ้ารอบในอนาคตเหลือน้อย (ระบบเปิดรับทุกศุกร์ไม่มีวันหมด)
      const topped = await topUpFutureFridays(rounds);
      if (topped.length !== rounds.length) {
        rounds = topped;
        await kv.set("rounds:all", rounds);
      }
    }

    // อ่านจำนวนที่จองจริงจากตัวนับ atomic เสมอ (แม่นยำ 100% ไม่มีทางคลาดเคลื่อน
    // ต่อให้มีคนจองพร้อมกันหลายคนตอนที่นั่งเหลือน้อยก็ตาม)
    const withRealCounts = await Promise.all(
      rounds.map(async (r) => {
        const counted = await kv.get(`round:booked:${r.id}`);
        return { ...r, booked: counted != null ? Number(counted) : (r.booked || 0) };
      })
    );

    const defaultCapacity = await getDefaultCapacity();
    res.status(200).json({
      rounds: withRealCounts,
      defaultCapacity,
      // ส่งเบอร์พร้อมเพย์ให้หน้าเว็บใช้สร้าง QR ด้วย (แหล่งข้อมูลเดียวกับที่ใช้ตรวจสอบสลิป
      // ใน verify-slip.js กันกรณีเปลี่ยนเบอร์ในอนาคตแล้วลืมแก้อีกที่ ทำให้ QR กับระบบ
      // ตรวจสอบไม่ตรงกัน)
      promptpayPhone: process.env.SHOP_PROMPTPAY_PHONE || null,
    });
    return;
  }

  if (req.method === "POST") {
    // 🔒 ป้องกันด้วย Session Login
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }
    let payload = {};
    try { const raw = await getRawBody(req); payload = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    // ── ตั้งค่าลิมิตออเดอร์ต่อวัน (ต่อรอบ) ที่จะใช้กับรอบใหม่ในอนาคต ──
    if (payload.defaultCapacity !== undefined) {
      const n = Number(payload.defaultCapacity);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({ error: "defaultCapacity ต้องเป็นตัวเลขมากกว่า 0" });
        return;
      }
      await kv.set("settings:defaultCapacity", n);
      logAdminAction(session.name, "แก้ไขลิมิตออเดอร์ต่อวัน", { newDefaultCapacity: n });
    }

    if (Array.isArray(payload.rounds)) {
      await kv.set("rounds:all", payload.rounds);
      logAdminAction(session.name, "แก้ไขข้อมูลรอบจอง", { roundsCount: payload.rounds.length });
    }

    const defaultCapacity = await getDefaultCapacity();
    res.status(200).json({ ok: true, rounds: payload.rounds || null, defaultCapacity });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};

// ⚠️ ต้องแนบ .config ตรงนี้ "หลัง" กำหนด module.exports เป็นฟังก์ชันแล้วเท่านั้น
module.exports.config = { api: { bodyParser: false } };
