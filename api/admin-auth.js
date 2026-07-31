// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Admin Login System (Vercel Serverless Function)
// วางไฟล์นี้ที่: /api/admin-auth.js
//
// ต้องตั้งค่า Environment Variable ใหม่:
//   ADMIN_ACCOUNTS = ชื่อ:username:password,ชื่อ2:username2:password2
//   ตัวอย่าง: เจ้าของร้าน:owner:MyP@ssw0rd,พนักงานเอ:staffA:Another123
//
//   POST /api/admin-auth?action=login
//        body: { username, password }
//        → ตรวจสอบ แล้วสร้าง session token คืนให้ (ใช้แนบไปกับ
//          request อื่นๆ ผ่าน header "x-admin-session")
//
//   POST /api/admin-auth?action=logout
//        body: { token }
//        → ปิด session บันทึกเวลาออก + ระยะเวลาที่ใช้งานทั้งหมด
//
//   GET  /api/admin-auth?action=verify
//        header: x-admin-session
//        → เช็คว่า session ยังใช้ได้ไหม (ใช้ตอนเปิดหน้าเว็บซ้ำ)
//
//   GET  /api/admin-auth?action=active-sessions
//        header: x-admin-session (ต้อง login แล้ว)
//        → ดูว่าใคร login ค้างอยู่ตอนนี้บ้าง (real-time)
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");
const {
  kv,
  SESSION_DURATION_MS,
  parseAdminAccounts,
  getClientIp,
  validateSession,
  logAdminAction,
  checkLoginLockout,
  recordFailedLogin,
  clearFailedLogins,
} = require("../lib/adminAuth");

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { action } = req.query;

  // ═══════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════
  if (req.method === "POST" && action === "login") {
    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const { username, password } = body;
    if (!username || !password) {
      res.status(400).json({ error: "กรุณากรอก username และ password" });
      return;
    }

    const ip = getClientIp(req);

    // ── เช็คว่าบัญชีนี้ถูกล็อกอยู่ไหม (เดารหัสผิดเกินกำหนด) ──
    const lockStatus = await checkLoginLockout(username);
    if (lockStatus.locked) {
      const unlocksAt = new Date(lockStatus.unlocksAt);
      const minutesLeft = Math.ceil((unlocksAt.getTime() - Date.now()) / 60000);
      await logAdminAction("ไม่ทราบชื่อ", `พยายาม Login ขณะบัญชีถูกล็อก (username: ${username})`, { ip });
      res.status(429).json({
        error: `บัญชีนี้ถูกล็อกชั่วคราวเนื่องจากใส่รหัสผิดหลายครั้ง กรุณาลองใหม่อีก ${minutesLeft} นาที`,
      });
      return;
    }

    const accounts = parseAdminAccounts();
    if (accounts.length === 0) {
      res.status(500).json({ error: "ระบบยังไม่ได้ตั้งค่า ADMIN_ACCOUNTS ใน Vercel" });
      return;
    }

    const account = accounts.find((a) => a.username === username && a.password === password);

    if (!account) {
      const failResult = await recordFailedLogin(username);
      if (failResult.justLocked) {
        await logAdminAction("ไม่ทราบชื่อ", `🔒 บัญชีถูกล็อกชั่วคราว 15 นาที (เดารหัสผิดเกิน ${failResult.attemptsUsed} ครั้ง)`, { username, ip });
        res.status(429).json({
          error: "ใส่รหัสผิดเกินกำหนด บัญชีนี้ถูกล็อกชั่วคราว 15 นาทีเพื่อความปลอดภัย",
        });
        return;
      }
      await logAdminAction("ไม่ทราบชื่อ", `พยายาม Login ผิด (username: ${username}, ครั้งที่ ${failResult.attemptsUsed}/5)`, { ip });
      res.status(401).json({ error: "username หรือ password ไม่ถูกต้อง" });
      return;
    }

    // Login สำเร็จ → ล้างประวัติเดารหัสผิดทิ้ง (ถ้ามี)
    await clearFailedLogins(username);

    const token = crypto.randomBytes(32).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

    const session = {
      token,
      name: account.name,
      username: account.username,
      ip,
      loginAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastSeenAt: now.toISOString(),
    };

    await kv.set(`session:${token}`, JSON.stringify(session));
    await kv.sadd("sessions:active", token);
    await logAdminAction(account.name, "🟢 Login เข้าใช้งาน", { ip });

    res.status(200).json({
      ok: true,
      token,
      name: account.name,
      username: account.username,
      expiresAt: session.expiresAt,
    });
    return;
  }

  // ═══════════════════════════════════════
  // LOGOUT
  // ═══════════════════════════════════════
  if (req.method === "POST" && action === "logout") {
    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const { token } = body;
    const session = await validateSession(token);

    if (session) {
      const durationMs = Date.now() - new Date(session.loginAt).getTime();
      const durationMin = Math.round(durationMs / 60000);
      await logAdminAction(session.name, "🔴 Logout ออกจากระบบ", {
        loginAt: session.loginAt,
        durationMinutes: durationMin,
      });
      await kv.del(`session:${token}`);
      await kv.srem("sessions:active", token);
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ═══════════════════════════════════════
  // VERIFY (เช็คว่า session ยังใช้ได้ไหม)
  // ═══════════════════════════════════════
  if (req.method === "GET" && action === "verify") {
    const token = req.headers["x-admin-session"];
    const session = await validateSession(token);
    if (!session) {
      res.status(401).json({ ok: false, error: "session หมดอายุหรือไม่ถูกต้อง กรุณา Login ใหม่" });
      return;
    }
    session.lastSeenAt = new Date().toISOString();
    await kv.set(`session:${token}`, JSON.stringify(session));
    res.status(200).json({ ok: true, name: session.name, username: session.username, expiresAt: session.expiresAt });
    return;
  }

  // ═══════════════════════════════════════
  // ACTIVE SESSIONS (ดูว่าใคร login ค้างอยู่ตอนนี้)
  // ═══════════════════════════════════════
  if (req.method === "GET" && action === "active-sessions") {
    const token = req.headers["x-admin-session"];
    const requester = await validateSession(token);
    if (!requester) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อน" });
      return;
    }

    const activeTokens = (await kv.smembers("sessions:active")) || [];
    const sessions = [];
    for (const t of activeTokens) {
      const data = await kv.get(`session:${t}`);
      if (!data) { await kv.srem("sessions:active", t); continue; }
      const s = typeof data === "string" ? JSON.parse(data) : data;
      if (Date.now() > new Date(s.expiresAt).getTime()) {
        await kv.del(`session:${t}`);
        await kv.srem("sessions:active", t);
        continue;
      }
      sessions.push({ name: s.name, username: s.username, ip: s.ip, loginAt: s.loginAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt });
    }
    sessions.sort((a, b) => new Date(b.loginAt) - new Date(a.loginAt));

    res.status(200).json({ total: sessions.length, sessions });
    return;
  }

  res.status(400).json({ error: "ต้องระบุ ?action=login, logout, verify, หรือ active-sessions" });
};
