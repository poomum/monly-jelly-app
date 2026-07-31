// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Admin Utilities (รวม 3 endpoint เข้าไฟล์เดียว)
// วางไฟล์นี้ที่: /api/admin-utils.js
//
// รวมไฟล์นี้เพื่อลดจำนวน Serverless Functions ให้อยู่ในลิมิตของ
// Vercel Hobby plan (สูงสุด 12 ฟังก์ชัน/deployment) — URL เดิมที่
// หน้าเว็บเรียกใช้ (/api/admin-log, /api/customers, /api/customer-history)
// ยังใช้งานได้เหมือนเดิมทุกอย่าง ผ่าน rewrites ใน vercel.json ที่ชี้มา
// ไฟล์นี้พร้อมแนบ ?resource= ต่อท้ายให้อัตโนมัติ ไม่ต้องแก้โค้ดหน้าเว็บเลย
//
//   GET /api/admin-utils?resource=log        → เดิมคือ /api/admin-log
//   GET /api/admin-utils?resource=customers  → เดิมคือ /api/customers
//   GET /api/admin-utils?resource=history&userId=X → เดิมคือ /api/customer-history
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
const { getCustomerPurchaseHistory } = require("../lib/purchaseHistory");

// ── resource=log (เดิม: api/admin-log.js) ──────────────────────
// ── resource=debug-env (เครื่องมือวินิจฉัยชั่วคราว — ใช้เสร็จแล้วลบทิ้ง) ──
// ไม่เช็ค login เพราะใช้ตอนที่ระบบ login เองก็อาจพังจากปัญหา env var
// ไม่โชว์ค่าจริงของตัวแปร แค่บอกว่า "มี/ไม่มี" + ความยาว เพื่อความปลอดภัย
function handleDebugEnv(req, res) {
  const allKeys = Object.keys(process.env).sort();
  const kvRelated = allKeys.filter((k) =>
    k.toUpperCase().includes("KV") ||
    k.toUpperCase().includes("REDIS") ||
    k.toUpperCase().includes("STORAGE") ||
    k.toUpperCase().includes("UPSTASH")
  );

  const summary = {};
  for (const key of kvRelated) {
    const value = process.env[key];
    summary[key] = {
      length: value ? value.length : 0,
      startsWithHttps: value ? value.startsWith("https://") : false,
      preview: value ? value.slice(0, 8) + "..." : "(ว่างเปล่า)",
    };
  }

  res.status(200).json({
    totalEnvVarsCount: allKeys.length,
    kvRelatedVarsFound: kvRelated,
    kvRelatedDetails: summary,
    codeChecks: {
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
      kv_KV_REST_API_URL: !!process.env.kv_KV_REST_API_URL,
      STORAGE_KV_REST_API_URL: !!process.env.STORAGE_KV_REST_API_URL,
      KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      kv_KV_REST_API_TOKEN: !!process.env.kv_KV_REST_API_TOKEN,
      STORAGE_KV_REST_API_TOKEN: !!process.env.STORAGE_KV_REST_API_TOKEN,
    },
  });
}

async function handleAdminLog(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const session = await validateSession(req.headers["x-admin-session"]);
  if (!session) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }

  const logData = await kv.get("admin:activity-log");
  let log = logData ? (typeof logData === "string" ? JSON.parse(logData) : logData) : [];

  const { admin: adminFilter, limit: limitRaw } = req.query;
  if (adminFilter) {
    log = log.filter((entry) => entry.admin === adminFilter);
  }

  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100;
  const trimmed = log.slice(0, limit);

  res.status(200).json({ total: log.length, showing: trimmed.length, log: trimmed });
}

// ── resource=customers (เดิม: api/customers.js) ────────────────
async function handleCustomers(req, res) {
  const session = await validateSession(req.headers["x-admin-session"]);
  if (!session) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }
  logAdminAction(session.name, "ดูรายชื่อลูกค้าทั้งหมด");

  const ids = (await kv.smembers("customers:index")) || [];
  const fetched = await Promise.all(ids.map((id) => kv.get(`customer:${id}`)));
  // ป้องกันเคสข้อมูลลูกค้าบางคนเผลอถูกเก็บเป็น string มาก่อน (เช่นจากบั๊กเก่า) — แกะให้เป็น object เสมอ
  let customers = fetched
    .filter(Boolean)
    .map((c) => (typeof c === "string" ? JSON.parse(c) : c));

  customers.sort(
    (a, b) => new Date(b.followedAt || 0) - new Date(a.followedAt || 0)
  );

  const totalMatched = customers.length;

  const limit = req.query.limit ? Math.max(1, Math.min(500, Number(req.query.limit))) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  if (limit) {
    const start = (page - 1) * limit;
    customers = customers.slice(start, start + limit);
  }

  res.status(200).json({
    total: totalMatched,
    following: fetched.filter(Boolean).filter((c) => c.isFollowing).length,
    page: limit ? page : 1,
    totalPages: limit ? Math.ceil(totalMatched / limit) : 1,
    customers,
  });
}

// ── resource=history (เดิม: api/customer-history.js) ───────────
async function handleCustomerHistory(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const { userId } = req.query;
  if (!userId) {
    res.status(400).json({ error: "ต้องระบุ ?userId=" });
    return;
  }

  const session = await validateSession(req.headers["x-admin-session"]);
  if (session) {
    logAdminAction(session.name, `ดูประวัติการสั่งซื้อลูกค้า (${userId})`);
  }

  const history = await getCustomerPurchaseHistory(userId);
  res.status(200).json(history);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { resource } = req.query;

  if (resource === "log") { await handleAdminLog(req, res); return; }
  if (resource === "debug-env") { handleDebugEnv(req, res); return; }
  if (resource === "customers") { await handleCustomers(req, res); return; }
  if (resource === "history") { await handleCustomerHistory(req, res); return; }

  res.status(400).json({ error: "ต้องระบุ ?resource=log, customers, หรือ history" });
};
