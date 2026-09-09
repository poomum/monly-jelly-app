// ═══════════════════════════════════════════════════════════════
// Monly Jelly – ไลบรารีกลางสำหรับระบบ Login แอดมิน
// วางไฟล์นี้ที่: /lib/adminAuth.js  (นอกโฟลเดอร์ api/ ตามคำแนะนำของ Vercel
// เพื่อไม่ให้ถูกนับเป็น serverless function แยก และกันปัญหาตอน build)
//
// ไฟล์ในโฟลเดอร์ api/ ที่ต้องใช้ระบบ login เรียกใช้ผ่าน:
//   const { validateSession, logAdminAction } = require("../lib/adminAuth");
// (หรือ "../../lib/adminAuth" ถ้าไฟล์อยู่ลึกกว่า 1 ชั้น เช่น api/customer/)
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

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // session หมดอายุใน 8 ชั่วโมง

// ── ป้องกันการเดารหัสผ่าน (Brute-force Protection) ──────────────
const MAX_FAILED_ATTEMPTS = 5;       // ผิดครบ 5 ครั้ง
const FAILED_WINDOW_MS = 15 * 60 * 1000;  // ภายใน 15 นาที
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // จะถูกล็อก 15 นาที

// เช็คว่า username นี้ถูกล็อกอยู่ไหม (คืน { locked: true, unlocksAt } ถ้าล็อกอยู่)
async function checkLoginLockout(username) {
  const data = await kv.get(`loginfail:${username}`);
  if (!data) return { locked: false };
  const record = typeof data === "string" ? JSON.parse(data) : data;
  if (record.lockedUntil && Date.now() < new Date(record.lockedUntil).getTime()) {
    return { locked: true, unlocksAt: record.lockedUntil };
  }
  return { locked: false };
}

// บันทึกว่า username นี้ล็อกอินผิด 1 ครั้ง คืนค่า true ถ้าเพิ่งถูกล็อกจากครั้งนี้พอดี
async function recordFailedLogin(username) {
  const key = `loginfail:${username}`;
  const data = await kv.get(key);
  const now = Date.now();
  let record = data ? (typeof data === "string" ? JSON.parse(data) : data) : null;

  // เริ่มนับใหม่ถ้ายังไม่เคยผิดมาก่อน หรือครั้งก่อนหน้าเกิน 15 นาทีที่แล้ว (นับรอบใหม่)
  if (!record || now - new Date(record.firstAttemptAt).getTime() > FAILED_WINDOW_MS) {
    record = { count: 0, firstAttemptAt: new Date(now).toISOString(), lockedUntil: null };
  }

  record.count += 1;
  let justLocked = false;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = new Date(now + LOCKOUT_DURATION_MS).toISOString();
    justLocked = true;
  }

  await kv.set(key, JSON.stringify(record));
  return { justLocked, lockedUntil: record.lockedUntil, attemptsUsed: record.count };
}

// ล้างประวัติผิดพลาดทิ้งทันทีที่ล็อกอินสำเร็จ
async function clearFailedLogins(username) {
  await kv.del(`loginfail:${username}`);
}

function parseAdminAccounts() {
  const configured = process.env.ADMIN_ACCOUNTS;
  if (!configured) return [];
  return configured
    .split(",")
    .map((entry) => {
      const parts = entry.trim().split(":");
      if (parts.length < 3) return null;
      const [name, username, ...pwParts] = parts;
      return { name: name.trim(), username: username.trim(), password: pwParts.join(":").trim() };
    })
    .filter(Boolean);
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

// ตรวจสอบ session token ว่ายังใช้ได้ไหม คืนข้อมูลแอดมินถ้าใช้ได้ (null ถ้าไม่ได้)
async function validateSession(token) {
  if (!token) return null;
  const sessionData = await kv.get(`session:${token}`);
  if (!sessionData) return null;
  const session = typeof sessionData === "string" ? JSON.parse(sessionData) : sessionData;
  if (Date.now() > new Date(session.expiresAt).getTime()) {
    await kv.del(`session:${token}`);
    await kv.srem("sessions:active", token);
    return null;
  }
  return session;
}

// บันทึกประวัติการใช้งานแอดมิน (ใครทำอะไร เมื่อไหร่) เก็บล่าสุด 500 รายการ
async function logAdminAction(adminName, action, details) {
  try {
    const logData = await kv.get("admin:activity-log");
    const log = logData ? (typeof logData === "string" ? JSON.parse(logData) : logData) : [];
    log.unshift({ admin: adminName, action, details: details || null, at: new Date().toISOString() });
    await kv.set("admin:activity-log", JSON.stringify(log.slice(0, 500)));
  } catch (e) {
    console.error("logAdminAction failed:", e);
  }
}

module.exports = {
  kv,
  SESSION_DURATION_MS,
  parseAdminAccounts,
  getClientIp,
  validateSession,
  logAdminAction,
  checkLoginLockout,
  recordFailedLogin,
  clearFailedLogins,
};
