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

async function lineGetProfile(userId, accessToken) {
  const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`getProfile failed: ${r.status}`);
  return r.json();
}

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

  // ── เพิ่มข้อมูลแต้มสะสม "พลังงานชีวิต" ให้แอดมินเห็นด้วย (เดิมมีแต่ประวัติซื้อ) ──
  // ต้องตรงกับ LOYALTY_POINTS_TARGET ใน lib/promotions.js เสมอ (ถ้าแก้ตรงนั้นต้องมาแก้ที่นี่ด้วย)
  const LOYALTY_POINTS_TARGET = 5;
  try {
    const raw = await kv.get(`customer:${userId}`);
    const customer = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    history.loyaltyPoints = customer ? (customer.loyaltyPoints || 0) : 0;
    history.loyaltyTarget = LOYALTY_POINTS_TARGET;
  } catch (e) {
    console.error("โหลดแต้มสะสมไม่สำเร็จ (ไม่กระทบข้อมูลประวัติซื้อส่วนอื่น):", e);
    history.loyaltyPoints = 0;
    history.loyaltyTarget = LOYALTY_POINTS_TARGET;
  }

  res.status(200).json(history);
}

// ── resource=backfill-followers (ดึงรายชื่อเพื่อนเก่าทั้งหมดมาลงทะเบียน
//    ย้อนหลัง — ใช้ตอนมีคนแอดเพื่อนไว้นานแล้ว "ก่อน" ระบบนี้ถูกสร้างขึ้นมา
//    เหตุการณ์ "แอดเพื่อน" ของเขาผ่านไปแล้ว ไม่มีทางย้อนกลับไปจับอัตโนมัติได้
//    ต้องดึงรายชื่อเพื่อนปัจจุบันทั้งหมดจาก LINE มาลงทะเบียนทีเดียว ──
//    หมายเหตุสำคัญ: endpoint นี้ของ LINE ใช้ได้เฉพาะบัญชี Verified/Premium
//    เท่านั้น (เช็คแล้วว่าบัญชีนี้เป็น Verified ใช้งานได้แน่นอน)
// ── resource=send-registration-broadcast (ส่ง Broadcast ชวนเพื่อนเก่า
//    กดปุ่มลงทะเบียนรับสิทธิ์สมาชิก — ใช้แทนการดึงรายชื่อแบบ bulk สำหรับ
//    บัญชี Unverified ที่เรียก Get Follower IDs API ไม่ได้) ──
//    Broadcast Message ส่งได้ทุกบัญชีไม่ว่าจะ Verified หรือไม่ ต่างจาก
//    Get Follower IDs API ที่จำกัดเฉพาะ Verified/Premium เท่านั้น
async function handleSendRegistrationBroadcast(req, res) {
  const token = req.headers["x-admin-session"];
  const session = await validateSession(token);
  if (!session) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }

  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(500).json({ error: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN" });
    return;
  }

  try {
    const r = await fetch("https://api.line.me/v2/bot/message/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messages: [
          {
            type: "text",
            text:
              `🎉 สวัสดีค่ะ! Monly Jelly มีระบบสมาชิกใหม่แล้วนะคะ\n\n` +
              `กดปุ่มด้านล่างเพื่อลงทะเบียนรับสิทธิ์:\n` +
              `⚡ สะสมแต้ม ได้ส่วนลดฟรี\n` +
              `🎁 คูปองวันเกิดพิเศษ\n` +
              `🔔 แจ้งเตือนสถานะออเดอร์อัตโนมัติ\n\n` +
              `ใช้เวลาแค่กดปุ่มเดียวค่ะ 💚`,
          },
          {
            type: "template",
            altText: "ลงทะเบียนรับสิทธิ์สมาชิก Monly Jelly",
            template: {
              type: "buttons",
              title: "🎁 ลงทะเบียนรับสิทธิ์สมาชิก",
              text: "กดปุ่มด้านล่างเพื่อรับสิทธิ์ทันที",
              actions: [
                { type: "postback", label: "✅ ลงทะเบียนเลย", data: "action=register_member" },
              ],
            },
          },
        ],
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      res.status(500).json({ error: `ส่ง Broadcast ไม่สำเร็จ: ${errText}` });
      return;
    }

    logAdminAction(session.name, "ส่ง Broadcast ชวนลงทะเบียนสมาชิก", {});
    res.status(200).json({ ok: true, message: "ส่ง Broadcast สำเร็จแล้วค่ะ" });
  } catch (e) {
    console.error("send-registration-broadcast error:", e);
    res.status(500).json({ error: "เกิดข้อผิดพลาด: " + e.message });
  }
}

async function handleBackfillFollowers(req, res) {
  const token = req.headers["x-admin-session"];
  const session = await validateSession(token);
  if (!session) {
    res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
    return;
  }

  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(500).json({ error: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN" });
    return;
  }

  try {
    // ดึงรายชื่อ userId ของเพื่อนทั้งหมดตอนนี้ (แบ่งหน้าทีละ 1000 คน ตาม
    // ข้อจำกัดของ LINE API เอง วนดึงจนกว่าจะครบทุกคน)
    let allUserIds = [];
    let continuationToken = null;
    do {
      const url = new URL("https://api.line.me/v2/bot/followers/ids");
      url.searchParams.set("limit", "1000");
      if (continuationToken) url.searchParams.set("start", continuationToken);
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        // สำคัญ: ถ้าบัญชีไม่ใช่ Verified/Premium LINE จะตอบ 403 ตรงนี้
        res.status(r.status === 403 ? 403 : 500).json({
          error: r.status === 403
            ? "บัญชี LINE OA ต้องเป็น Verified หรือ Premium เท่านั้นถึงจะใช้ฟีเจอร์นี้ได้ค่ะ"
            : `ดึงรายชื่อเพื่อนจาก LINE ไม่สำเร็จ: ${errText}`,
        });
        return;
      }
      const data = await r.json();
      allUserIds = allUserIds.concat(data.userIds || []);
      continuationToken = data.next || null;
    } while (continuationToken);

    // เช็คว่าใครยังไม่เคยถูกลงทะเบียนไว้บ้าง (ข้ามคนที่มีข้อมูลอยู่แล้ว กัน
    // เขียนทับข้อมูลที่มีอยู่แล้วโดยไม่จำเป็น เช่น เบอร์โทร/ที่อยู่ที่เคยกรอกไว้)
    const existingIds = (await kv.smembers("customers:index")) || [];
    const existingSet = new Set(existingIds);
    const newUserIds = allUserIds.filter((id) => !existingSet.has(id));

    let registered = 0;
    let failed = 0;
    for (const userId of newUserIds) {
      try {
        const profile = await lineGetProfile(userId, accessToken);
        const customer = {
          userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          statusMessage: profile.statusMessage || "",
          followedAt: new Date().toISOString(), // ไม่รู้วันที่แอดจริง ใช้วันที่ backfill แทน
          lastSeenAt: new Date().toISOString(),
          isFollowing: true,
          backfilled: true, // เก็บไว้เป็น audit trail ว่าลงทะเบียนย้อนหลัง ไม่ใช่จากการแอดเพื่อนสดๆ
        };
        await kv.set(`customer:${userId}`, customer);
        await kv.sadd("customers:index", userId);
        registered++;
      } catch (e) {
        console.error(`backfill failed for ${userId}:`, e.message);
        failed++;
      }
    }

    logAdminAction(session.name, "ลงทะเบียนเพื่อนเก่าย้อนหลัง", {
      totalFollowers: allUserIds.length,
      alreadyRegistered: allUserIds.length - newUserIds.length,
      newlyRegistered: registered,
      failed,
    });

    res.status(200).json({
      ok: true,
      totalFollowers: allUserIds.length,
      alreadyRegistered: allUserIds.length - newUserIds.length,
      newlyRegistered: registered,
      failed,
    });
  } catch (e) {
    console.error("backfill-followers error:", e);
    res.status(500).json({ error: "เกิดข้อผิดพลาด: " + e.message });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { resource } = req.query;

  if (resource === "log") { await handleAdminLog(req, res); return; }
  if (resource === "debug-env") { handleDebugEnv(req, res); return; }
  if (resource === "customers") { await handleCustomers(req, res); return; }
  if (resource === "history") { await handleCustomerHistory(req, res); return; }
  if (resource === "backfill-followers" && req.method === "POST") { await handleBackfillFollowers(req, res); return; }
  if (resource === "send-registration-broadcast" && req.method === "POST") { await handleSendRegistrationBroadcast(req, res); return; }

  res.status(400).json({ error: "ต้องระบุ ?resource=log, customers, history, หรือ backfill-followers" });
};
