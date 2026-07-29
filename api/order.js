// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Order API (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/order.js
//   POST  /api/order    → บันทึกออเดอร์ + เพิ่มยอดจองในรอบ + แจ้งลูกค้าทาง LINE
//   GET   /api/order    → (แอดมิน) ดูออเดอร์ทั้งหมด
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
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

function genOrderId() {
  return "MJ-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function linePush(userId, messages, accessToken) {
  if (!userId || !accessToken) return;
  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (!resp.ok) {
      // สำคัญ: fetch() ไม่ throw error ตอน LINE ตอบ 429/403 (เช่น โควตาข้อความ
      // รายเดือนหมด หรือ rate limit) ต้องเช็ค status เองเสมอ ไม่งั้นจะไม่รู้เลย
      // ว่าข้อความส่งไม่สำเร็จ (เงียบแบบไม่มี error ให้เห็น)
      const errText = await resp.text().catch(() => "");
      console.error(`LINE push failed: HTTP ${resp.status} — ${errText}`);
    }
  } catch (e) { console.error("LINE push failed (network error):", e); }
}

// ── คืนที่นั่งให้รอบ + เลื่อนคิวสำรองขึ้นมาแทนอัตโนมัติ (เรียกตอนออร์เดอร์ถูกยกเลิก) ──
async function promoteFromWaitlist(roundId, accessToken) {
  try {
    // คืนที่นั่ง 1 ที่ให้รอบนี้ก่อน (คนที่ยกเลิกสละสิทธิ์)
    const counterKey = `round:booked:${roundId}`;
    await kv.decr(counterKey);

    // เช็คคิวสำรองของรอบนี้ ถ้ามีคนรออยู่ → เลื่อนคนแรกสุดขึ้นมาแทนทันที
    const waitlistData = await kv.get(`waitlist:${roundId}`);
    const waitlist = waitlistData
      ? (typeof waitlistData === "string" ? JSON.parse(waitlistData) : waitlistData)
      : [];

    if (waitlist.length === 0) return null; // ไม่มีคนรอคิว ไม่ต้องทำอะไรต่อ

    const next = waitlist.shift(); // คนแรกสุดที่ต่อคิวไว้ (FIFO)
    await kv.set(`waitlist:${roundId}`, JSON.stringify(waitlist));

    // จองที่นั่งคืนให้คนที่เลื่อนคิวขึ้นมา
    await kv.incr(counterKey);

    // สร้างออร์เดอร์ใหม่ให้อัตโนมัติ (ใช้ข้อมูลที่เขาให้ไว้ตอนต่อคิวสำรอง)
    const rounds = (await kv.get("rounds:all")) || [];
    const roundInfo = rounds.find((r) => r.id === roundId);

    let promotedOrderId;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = genOrderId();
      const exists = await kv.get(`order:${candidate}`);
      if (!exists) { promotedOrderId = candidate; break; }
    }

    const promotedOrder = {
      orderId: promotedOrderId,
      userId: next.userId,
      round: roundInfo ? { id: roundInfo.id, date: roundInfo.date } : { id: roundId },
      items: next.items || [],
      shipping: next.shipping || null,
      grandTotal: next.grandTotal || 0,
      customer: { name: next.name, phone: next.phone, addr: next.addr, email: next.email, birth: next.birth },
      status: "pending_payment",
      promotedFromWaitlist: true,
      createdAt: new Date().toISOString(),
    };
    await kv.set(`order:${promotedOrderId}`, promotedOrder);
    await kv.sadd("orders:index", promotedOrderId);
    if (next.userId) await kv.sadd(`orders:user:${next.userId}`, promotedOrderId);

    // แจ้ง LINE ให้คนที่เลื่อนคิวขึ้นมาทราบทันที
    if (next.userId && accessToken) {
      const liffId = process.env.LIFF_ID;
      const trackLink = liffId ? `https://liff.line.me/${liffId}?orderId=${promotedOrderId}` : null;
      const text =
        `🎉 มีที่ว่างแล้วค่ะ ${next.name}!\n\n` +
        `คิวสำรองของคุณสำหรับรอบ ${roundInfo ? roundInfo.date : ""} ได้เลื่อนขึ้นมาเป็นออร์เดอร์จริงแล้ว\n\n` +
        `📦 ออเดอร์ #${promotedOrderId}\n💰 ยอดชำระ: ฿${promotedOrder.grandTotal}\n\n` +
        `กรุณาโอนชำระและส่งสลิปกลับมาในแชทนี้เพื่อยืนยันที่นั่งนะคะ 💚\n\n` +
        (trackLink ? `🔗 ติดตามสถานะได้ที่: ${trackLink}` : "");
      await linePush(next.userId, [{ type: "text", text }], accessToken);
    }

    return { promotedOrderId, userId: next.userId };
  } catch (e) {
    console.error("promoteFromWaitlist error:", e);
    return null;
  }
}

// ── ราคาจริงที่อ้างอิงได้ (ต้องตรงกับหน้าเว็บ index.html เป๊ะ) ──
// สำคัญมาก: ห้ามเชื่อราคา/ยอดรวมที่ส่งมาจากฝั่งลูกค้าเด็ดขาด เพราะแก้ไขผ่าน
// Developer Tools ในเบราว์เซอร์ได้ง่ายมาก ต้องคำนวณราคาจริงจากรายการนี้เท่านั้น
// ── ระบบ Login แอดมิน (session-based) — ใช้ไฟล์กลางร่วมกับ api อื่นๆ ──
const { validateSession, logAdminAction } = require("../lib/adminAuth");

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
const MAX_QTY_PER_ITEM = 50; // กันสั่งจำนวนเยอะผิดปกติ (พิมพ์ผิด/บอทยิงสแปม)

// ตรวจสอบ + คำนวณยอดจริงจากรายการสินค้า (ไม่สนใจราคา/ยอดที่ลูกค้าส่งมาเลย)
function validateAndPriceOrder(order) {
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return { error: "กรุณาเลือกสินค้าอย่างน้อย 1 รายการ" };
  }

  const verifiedItems = [];
  for (const raw of order.items) {
    const canonical = CANONICAL_PRODUCTS[raw && raw.id];
    if (!canonical) {
      return { error: `ไม่พบสินค้ารหัส "${raw && raw.id}" ในระบบ` };
    }
    const qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY_PER_ITEM) {
      return { error: `จำนวนสินค้า "${canonical.name}" ไม่ถูกต้อง` };
    }
    verifiedItems.push({ id: raw.id, name: canonical.name, price: canonical.price, qty });
  }

  const shippingId = order.shipping && order.shipping.id;
  const canonicalShipping = CANONICAL_SHIPPING[shippingId];
  if (!canonicalShipping) {
    return { error: "กรุณาเลือกวิธีจัดส่งให้ถูกต้อง" };
  }

  const itemsTotal = verifiedItems.reduce((s, it) => s + it.price * it.qty, 0);
  const grandTotal = itemsTotal + canonicalShipping.price;

  return {
    items: verifiedItems,
    shipping: { id: shippingId, name: canonicalShipping.name, price: canonicalShipping.price },
    grandTotal,
  };
}

// ตรวจสอบข้อมูลลูกค้าพื้นฐาน (กันค่าว่าง/ยาวผิดปกติ)
function validateCustomerInfo(customer) {
  const c = customer || {};
  const name = String(c.name || "").trim();
  const phone = String(c.phone || "").trim();
  const addr = String(c.addr || "").trim();
  if (!name || name.length > 100) return { error: "กรุณากรอกชื่อผู้รับให้ถูกต้อง" };
  if (!phone || phone.replace(/\D/g, "").length < 9) return { error: "กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง" };
  if (!addr || addr.length > 500) return { error: "กรุณากรอกที่อยู่จัดส่งให้ถูกต้อง" };
  return {
    name, phone, addr,
    email: String(c.email || "").trim().slice(0, 200),
    birth: String(c.birth || "").trim().slice(0, 20),
  };
}



module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // ── ดูออเดอร์ทั้งหมด (แอดมิน) ──
  //    รองรับแบ่งหน้า: /api/order?limit=50&page=1&status=pending_payment
  //    (สำคัญสำหรับอนาคต: พอออร์เดอร์เยอะขึ้นหลักพันรายการ จะได้ไม่ต้องโหลด
  //    ทั้งหมดทีเดียวจนหน้าแอดมินช้า/payload ใหญ่เกินไป)
  if (req.method === "GET") {
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" }); return;
    }
    logAdminAction(session.name, "ดูรายการออร์เดอร์ทั้งหมด"); // ไม่ await กันหน่วงการตอบกลับ
    const ids = (await kv.smembers("orders:index")) || [];
    // ดึงออร์เดอร์ทั้งหมดแบบขนาน (เร็วขึ้นมาก รองรับออร์เดอร์หลักร้อย-พันรายการได้)
    const fetched = await Promise.all(ids.map((id) => kv.get(`order:${id}`)));
    let orders = fetched.filter(Boolean);
    orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    // กรองตามสถานะ (ถ้าระบุมา) เช่น ?status=pending_payment
    const { status: statusFilter, roundId: roundIdFilter } = req.query;
    if (statusFilter) orders = orders.filter((o) => o.status === statusFilter);
    if (roundIdFilter) orders = orders.filter((o) => o.round && o.round.id === roundIdFilter);

    const totalMatched = orders.length;

    // แบ่งหน้า (ค่าเริ่มต้น: หน้า 1, 100 รายการ/หน้า — ถ้าไม่ระบุ limit จะส่งทั้งหมดเหมือนเดิม
    // เพื่อไม่ให้กระทบเครื่องมือเก่าที่เคยเรียกใช้แบบไม่แบ่งหน้า)
    const limit = req.query.limit ? Math.max(1, Math.min(500, Number(req.query.limit))) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    if (limit) {
      const start = (page - 1) * limit;
      orders = orders.slice(start, start + limit);
    }

    res.status(200).json({
      total: totalMatched,
      page: limit ? page : 1,
      totalPages: limit ? Math.ceil(totalMatched / limit) : 1,
      orders,
    });
    return;
  }

  if (req.method !== "POST" && req.method !== "PATCH") {
    res.status(405).json({ error: "method not allowed" }); return;
  }

  // ── แอดมินอัปเดตสถานะออเดอร์ ──
  if (req.method === "PATCH") {
    const adminSession = await validateSession(req.headers["x-admin-session"]);
    if (!adminSession) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" }); return;
    }
    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const { orderId, status, trackingNumber: manualTrackingNumber } = body;
    if (!orderId) { res.status(400).json({ error: "orderId required" }); return; }
    const id = String(orderId).trim().toUpperCase();
    const existing = await kv.get(`order:${id}`);
    if (!existing) { res.status(404).json({ error: "order not found" }); return; }

    // ── ถ้าเปลี่ยนเป็น "shipped" และไม่ได้พิมพ์เลขแทร็กกิ้งมาเอง
    //    → ดึงเลขถัดไปจาก "คลังเลขพัสดุ" ของขนส่งที่ลูกค้าเลือกไว้ตอนสั่งซื้อ ให้อัตโนมัติ ──
    let trackingNumber = manualTrackingNumber;
    let drawnFromPool = false;
    let poolCarrier = null;
    if (status === "shipped" && !trackingNumber && !existing.trackingNumber) {
      poolCarrier = existing.shipping && existing.shipping.id; // "regular" | "ems" | "flash" | "kerry"
      if (poolCarrier) {
        const drawn = await kv.lpop(`tracking:pool:${poolCarrier}`);
        if (drawn) {
          trackingNumber = drawn;
          drawnFromPool = true;
        }
      }
    }

    const updated = {
      ...existing,
      ...(status ? { status } : {}),
      ...(trackingNumber ? { trackingNumber } : {}),
      updatedAt: new Date().toISOString(),
    };
    await kv.set(`order:${id}`, updated);

    // บันทึกว่าแอดมินคนไหนแก้ไขออร์เดอร์นี้ เมื่อไหร่ เปลี่ยนอะไรบ้าง
    logAdminAction(adminSession.name, `แก้ไขออร์เดอร์ #${id}`, {
      orderId: id,
      newStatus: status || null,
      trackingNumber: trackingNumber || null,
    });

    // ── ถ้ายกเลิกออเดอร์ → คืนที่นั่งให้รอบ + เลื่อนคิวสำรองขึ้นมาแทนอัตโนมัติ ──
    let promoted = null;
    if (status === "cancelled" && existing.status !== "cancelled" && existing.round && existing.round.id) {
      promoted = await promoteFromWaitlist(existing.round.id, process.env.LINE_CHANNEL_ACCESS_TOKEN);
    }

    // แจ้งลูกค้าทาง LINE เมื่อสถานะเปลี่ยน
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (status && existing.userId && accessToken) {
      const STATUS_LABEL = {
        pending_payment: "รอชำระเงิน 💰",
        paid: "พร้อมรับออเดอร์แล้ว ✅",
        processing: "กำลังดำเนินการเตรียมสินค้า 🍬",
        packed: "แพ็กสินค้าเรียบร้อย 📦",
        shipped: "พร้อมจัดส่งสินค้าไปยังคุณลูกค้า 🚚",
        delivered: "ถึงมือลูกค้าแล้ว 🎉",
        cancelled: "ยกเลิกออเดอร์ ❌",
      };
      const label = STATUS_LABEL[status] || status;
      const liffId = process.env.LIFF_ID;
      const trackLink = liffId ? `https://liff.line.me/${liffId}?orderId=${id}` : null;
      const trackLine = trackLink
        ? `🔗 ติดตามสถานะออเดอร์ได้ตลอดเวลาที่ลิงก์นี้:\n${trackLink}`
        : `พิมพ์ "ติดตาม" ในแชทนี้เพื่อเช็คสถานะได้ตลอดค่ะ`;
      const supportLine = "หากมีข้อสงสัยสอบถามเพิ่มเติมได้ทางแชทนี้ตลอดเวลาทำการเลยนะคะ 💚";

      let text;
      if (status === "paid") {
        text =
          `✅ ยืนยันการชำระเงินเรียบร้อยแล้วค่ะ! 🎉\n\n` +
          `📦 ออเดอร์ #${id} ${label}\n\n` +
          `⏳ สินค้านี้เป็นสินค้า Pre-Order นะคะ หลังชำระเงินทางร้านจะใช้เวลาประมาณ 3-4 วันทำการในการเตรียมและจัดส่งสินค้าให้คุณลูกค้าค่ะ\n\n` +
          `ตอนนี้ออเดอร์ของคุณกำลังอยู่ระหว่างดำเนินการ (3-4 วัน) หลังจากทำขนมเสร็จเรียบร้อย ทางร้านจะอัปเดตสถานะเป็น "พร้อมจัดส่งสินค้า" พร้อมเลขพัสดุให้ทันทีค่ะ\n\n` +
          `${trackLine}\n\n${supportLine}`;
      } else if (status === "shipped") {
        const trackNoLine = trackingNumber ? `📮 เลขพัสดุ: ${trackingNumber}\n\n` : "";
        text =
          `🚚 ${label}\n\n` +
          `📦 ออเดอร์ #${id}\n\n` +
          trackNoLine +
          `กรุณาเช็คสถานะและเลขแทร็กกิ้งได้ตามลิงก์ด้านล่างค่ะ:\n${trackLink || "พิมพ์ \"ติดตาม\" ในแชทนี้ได้เลยค่ะ"}\n\n${supportLine}`;
      } else {
        const trackNoLine = trackingNumber ? `\n📮 เลขพัสดุ: ${trackingNumber}` : "";
        text =
          `📢 อัปเดตออเดอร์ #${id}\n\n` +
          `สถานะล่าสุด: ${label}${trackNoLine}\n\n` +
          `${trackLine}\n\n${supportLine}`;
      }

      await linePush(existing.userId, [{ type: "text", text }], accessToken);
    }

    const poolRemaining = poolCarrier ? await kv.llen(`tracking:pool:${poolCarrier}`).catch(() => null) : null;
    res.status(200).json({
      ok: true,
      order: updated,
      trackingNumberDrawnFromPool: drawnFromPool,
      poolCarrier,
      poolRemaining,
      ...(promoted ? { waitlistPromoted: promoted } : {}),
      ...(drawnFromPool && poolRemaining === 0
        ? { poolWarning: `เลขพัสดุของ "${poolCarrier}" ในคลังหมดแล้ว กรุณาเติมเลขชุดใหม่ผ่าน /api/tracking-pool` }
        : {}),
    });
    return;
  }

  // ── บันทึกออเดอร์ใหม่ ──
  let order = {};
  try { const raw = await getRawBody(req); order = raw ? JSON.parse(raw) : {}; }
  catch { res.status(400).json({ error: "invalid json" }); return; }

  // ── ตรวจสอบและคำนวณราคาจริงฝั่งเซิร์ฟเวอร์ (ไม่เชื่อราคา/ยอดจากลูกค้าเด็ดขาด) ──
  const priced = validateAndPriceOrder(order);
  if (priced.error) { res.status(400).json({ error: priced.error }); return; }

  const validCustomer = validateCustomerInfo(order.customer);
  if (validCustomer.error) { res.status(400).json({ error: validCustomer.error }); return; }

  // เขียนทับด้วยค่าที่ตรวจสอบแล้วเสมอ (ป้องกันการปลอมแปลงราคาผ่าน Developer Tools)
  order = {
    ...order,
    items: priced.items,
    shipping: priced.shipping,
    grandTotal: priced.grandTotal,
    customer: validCustomer,
  };

  // ── กันจองซ้ำโดยไม่ตั้งใจ (กดปุ่มซ้ำเร็วๆ / เปิด 2 แท็บ / เน็ตดีเลย์แล้วกดใหม่) ──
  // ถ้าลูกค้าคนเดิมเพิ่งจองรอบเดียวกันนี้ไปภายใน 30 วินาทีที่แล้ว และยังไม่ได้จ่ายเงิน
  // ให้ถือว่าเป็นการกดซ้ำ คืนออร์เดอร์เดิมกลับไปแทนที่จะสร้างใหม่ซ้ำซ้อน
  if (order.userId && order.round && order.round.id) {
    const myOrderIds = (await kv.smembers(`orders:user:${order.userId}`)) || [];
    if (myOrderIds.length > 0) {
      const recentOrders = await Promise.all(myOrderIds.map((id) => kv.get(`order:${id}`)));
      const THIRTY_SEC = 30 * 1000;
      const duplicate = recentOrders.find((o) => {
        if (!o || o.status !== "pending_payment") return false;
        if (!o.round || o.round.id !== order.round.id) return false;
        const age = Date.now() - new Date(o.createdAt).getTime();
        return age >= 0 && age < THIRTY_SEC;
      });
      if (duplicate) {
        res.status(200).json({ ok: true, orderId: duplicate.orderId, order: duplicate, duplicatePrevented: true });
        return;
      }
    }
  }

  // ── สร้างเลขออร์เดอร์ที่ไม่ซ้ำแน่นอน (เช็คกับฐานข้อมูลจริงก่อนใช้) ──
  // กันกรณีสุ่มเลขชนกัน (เกิดได้แม้โอกาสน้อยมาก) ซึ่งถ้าไม่เช็คจะทำให้
  // ออร์เดอร์เก่าที่เลขซ้ำถูกข้อมูลใหม่ทับไปโดยไม่รู้ตัว
  let orderId;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = genOrderId();
    const exists = await kv.get(`order:${candidate}`);
    if (!exists) {
      orderId = candidate;
      break;
    }
  }
  if (!orderId) {
    res.status(500).json({ error: "ระบบสร้างเลขออร์เดอร์ขัดข้อง กรุณาลองใหม่อีกครั้งค่ะ" });
    return;
  }

  // ── กันจองเกินที่นั่ง (ป้องกันหลายคนกดพร้อมกันตอนเหลือที่นั่งน้อย) ──
  // ใช้ตัวนับแบบ atomic (kv.incr) แทนการอ่าน-แก้-เขียนทับ array ตรงๆ
  // เพราะ incr ของ Redis รับประกันว่าจะไม่มี 2 คนแซงกันนับเลขเดียวกันได้
  if (order.round && order.round.id) {
    const rounds = (await kv.get("rounds:all")) || [];
    const roundInfo = rounds.find((r) => r.id === order.round.id);
    if (!roundInfo) {
      res.status(400).json({ error: "ไม่พบรอบที่เลือก กรุณาเลือกรอบใหม่อีกครั้ง" });
      return;
    }

    const counterKey = `round:booked:${order.round.id}`;
    const newCount = await kv.incr(counterKey);

    if (newCount > roundInfo.capacity) {
      // เต็มแล้ว → ลดตัวนับคืน แล้วปฏิเสธออร์เดอร์นี้ทันที (ไม่บันทึก)
      await kv.decr(counterKey);
      res.status(409).json({
        error: `ขออภัยค่ะ รอบ ${roundInfo.date} เต็มแล้วพอดี กรุณาเลือกรอบอื่นนะคะ 🙏`,
        roundFull: true,
      });
      return;
    }

    // จองสำเร็จ → sync ตัวเลขไปที่ rounds:all ด้วย (ไว้แสดงผลในหน้าเว็บ)
    roundInfo.booked = newCount;
    await kv.set("rounds:all", rounds);
  }

  const record = {
    orderId,
    ...order,
    status: "pending_payment",
    createdAt: order.createdAt || new Date().toISOString(),
  };

  // save order
  await kv.set(`order:${orderId}`, record);
  await kv.sadd("orders:index", orderId);
  if (order.userId) await kv.sadd(`orders:user:${order.userId}`, orderId);

  // push LINE confirmation to customer (ก่อนชำระเงิน)
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (order.userId && accessToken) {
    const itemLines = (order.items || [])
      .map((it) => `• ${it.name} ×${it.qty} = ฿${it.price * it.qty}`)
      .join("\n");
    const c = order.customer || {};
    const text =
      `🎉 ยืนยันการจอง #${orderId}\n\n` +
      `📅 รอบผลิต: ${order.round ? order.round.date : "-"}\n\n` +
      `🛒 รายการ:\n${itemLines}\n\n` +
      `🚚 จัดส่ง: ${order.shipping ? order.shipping.name : "-"} ฿${order.shipping ? order.shipping.price : 0}\n` +
      `💰 ยอดรวม: ฿${order.grandTotal}\n\n` +
      `📦 ผู้รับ: ${c.name || "-"}\n📞 ${c.phone || "-"}\n🏠 ${c.addr || "-"}\n` +
      (c.email ? `✉️ ${c.email}\n` : "") +
      `\nกรุณาโอนชำระแล้วส่งสลิปกลับมาในแชทนี้นะคะ 💚\n\n` +
      `หากมีข้อสงสัยสอบถามเพิ่มเติมได้ทางแชทนี้ตลอดเวลาทำการเลยนะคะ 💚`;
    await linePush(order.userId, [{ type: "text", text }], accessToken);
  }

  res.status(200).json({ ok: true, orderId, order: record });
};
