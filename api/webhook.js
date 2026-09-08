// ═══════════════════════════════════════════════════════════════
// Monly Jelly – LINE Webhook (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/webhook.js  (รากโปรเจกต์ ระดับเดียวกับ package.json)
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");
const { createClient } = require("@vercel/kv");

// ── ราคาอ้างอิง (ต้องตรงกับ index.html, api/order.js, api/waitlist.js เป๊ะ) ──
// ใช้แค่โชว์ข้อความสรุปราคาให้ลูกค้าทางแชท ไม่ได้ใช้คำนวณเงินจริง
// (การคำนวณเงินจริงอยู่ที่ api/order.js ซึ่งเป็นจุดเดียวที่น่าเชื่อถือได้)
const REFERENCE_PRICE_SINGLE = 89;   // ราคาแยกรส (6 ชิ้น)
const REFERENCE_PRICE_MIX = 189;     // ราคาซองรวม 3 รส (12 ชิ้น)

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
    // สำคัญมาก: ต้องเก็บเป็น Buffer array แล้วค่อย concat รวมกันทีเดียวตอนจบ
    // ห้ามแปลงเป็น string ทีละ chunk (เช่น data += chunk) เด็ดขาด เพราะถ้า
    // ข้อมูลถูกแบ่งส่งมาหลาย chunk แล้วบังเอิญตัดตรงกลางตัวอักษรภาษาไทย/
    // อีโมจิ (multi-byte UTF-8) จะทำให้ตัวอักษรเพี้ยน ส่งผลให้คำนวณ HMAC
    // signature ได้ค่าผิด ไม่ตรงกับที่ LINE คำนวณมา ทำให้ Verify Webhook
    // ขึ้น 401 Unauthorized ทั้งที่ LINE_CHANNEL_SECRET ถูกต้อง 100% แล้ว
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature, secret) {
  const hash = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return hash === signature;
}

async function lineGetProfile(userId, accessToken) {
  const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`getProfile failed: ${r.status}`);
  return r.json();
}

// ── สรุปคูปองที่ลูกค้าคนนี้มีอยู่ตอนนี้ (ยังไม่ได้ใช้ + ยังไม่หมดอายุ) ──
// ใช้ตอนลูกค้าทักมาว่า "สั่ง" (สนใจจะซื้อของ) เพื่อเตือนให้รู้ว่ามีส่วนลด
// อะไรเหลืออยู่บ้าง จะได้ไม่พลาดใช้ก่อนหมดอายุ — รวมทุกแหล่งที่มา (วันเกิด,
// สะสมแต้ม, ส่วนลดเฉพาะบุคคล, จากเกม) เป็นสรุปเดียวให้เห็นภาพรวมชัดเจน
async function buildCouponSummary(userId) {
  if (!userId) return null;
  try {
    const couponsRaw = await kv.get(`coupons:${userId}`);
    const coupons = couponsRaw ? (typeof couponsRaw === "string" ? JSON.parse(couponsRaw) : couponsRaw) : [];
    const now = new Date();
    const usable = coupons.filter((c) => {
      if (c.usedAt || c.used) return false; // ใช้ไปแล้ว ข้าม
      if (!c.expiresAt) return true; // ไม่มีวันหมดอายุ ถือว่าใช้ได้เสมอ
      return new Date(c.expiresAt) > now; // ยังไม่หมดอายุ
    });
    if (!usable.length) return null;

    const SOURCE_LABEL = {
      birthday: "🎂 คูปองวันเกิด",
      loyalty: "⚡ รางวัลสะสมแต้ม",
      personal: "🎁 ส่วนลดพิเศษจากร้าน",
      game: "🎮 โค้ดจากเกม",
    };
    const lines = usable.map((c) => {
      const label = SOURCE_LABEL[c.source] || "🎟️ คูปอง";
      const discount = c.discount ? `฿${c.discount}` : "";
      const daysLeft = c.expiresAt ? Math.max(0, Math.ceil((new Date(c.expiresAt) - now) / (1000 * 60 * 60 * 24))) : null;
      const expiryText = daysLeft !== null ? ` (เหลือ ${daysLeft} วัน)` : "";
      return `${label} ${discount} — โค้ด ${c.code}${expiryText}`;
    });
    return `🎁 ตอนนี้คุณมีคูปองที่ใช้ได้อยู่นะคะ:\n${lines.join("\n")}\n\nอย่าลืมใช้ก่อนหมดอายุนะคะ! 💚\n`;
  } catch (e) {
    console.error("buildCouponSummary failed:", e);
    return null;
  }
}

async function lineReply(replyToken, messages, accessToken) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

const STATUS_LABEL_TH = {
  pending_payment: "รอชำระเงิน 💰",
  paid: "พร้อมรับออเดอร์แล้ว กำลังเตรียมสินค้า (3-4 วัน) ✅",
  processing: "กำลังดำเนินการเตรียมสินค้า 🍬",
  packed: "แพ็กสินค้าเรียบร้อย 📦",
  shipped: "พร้อมจัดส่งสินค้าไปยังคุณลูกค้า 🚚",
  delivered: "ถึงมือลูกค้าแล้ว 🎉",
  cancelled: "ยกเลิกออเดอร์ ❌",
};

function formatOrderStatusText(o, liffId) {
  const label = STATUS_LABEL_TH[o.status] || o.status || "รอชำระเงิน 💰";
  const track = o.trackingNumber ? `\n📮 เลขพัสดุ: ${o.trackingNumber}` : "";
  const items = (o.items || []).map((it) => `• ${it.name} ×${it.qty}`).join("\n");
  const trackLink = liffId ? `https://liff.line.me/${liffId}?orderId=${o.orderId}` : null;
  return (
    `📦 สถานะออเดอร์ #${o.orderId}\n\n` +
    `สถานะปัจจุบัน: ${label}${track}\n\n` +
    (items ? `รายการ:\n${items}\n\n` : "") +
    `💰 ยอดรวม: ฿${o.grandTotal || "-"}\n\n` +
    (trackLink ? `🔗 เปิดดูสถานะแบบละเอียด:\n${trackLink}\n\n` : "") +
    `หากมีข้อสงสัยสอบถามเพิ่มเติมได้ทางแชทนี้ตลอดเวลาทำการเลยนะคะ 💚`
  );
}

// ── ตอบสถานะออเดอร์ให้ลูกค้า (พิมพ์ "ติดตาม" หรือเลขออเดอร์ MJ-xxxxxx) ──
async function handleTrackingReply(replyToken, userId, orderIdFromText, accessToken, liffId) {
  try {
    // กรณีระบุเลขออเดอร์มาตรงๆ ในข้อความ
    if (orderIdFromText) {
      const o = await kv.get(`order:${orderIdFromText}`);
      if (!o) {
        await lineReply(replyToken, [{ type: "text", text: `ไม่พบออเดอร์ #${orderIdFromText} ค่ะ ลองเช็คเลขอีกครั้งนะคะ 🙏` }], accessToken);
        return;
      }
      await lineReply(replyToken, [{ type: "text", text: formatOrderStatusText(o, liffId) }], accessToken);
      return;
    }

    // กรณีพิมพ์แค่ "ติดตาม" → หาออเดอร์ล่าสุดของลูกค้าคนนี้
    const ids = (await kv.smembers(`orders:user:${userId}`)) || [];
    if (ids.length === 0) {
      await lineReply(replyToken, [{
        type: "text",
        text: `ยังไม่พบออเดอร์ในระบบค่ะ 🍬\nกดจองสินค้าได้ที่นี่เลย 👉 https://liff.line.me/${liffId}`,
      }], accessToken);
      return;
    }
    const orders = [];
    for (const id of ids) {
      const o = await kv.get(`order:${id}`);
      if (o) orders.push(o);
    }
    orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const latest = orders[0];
    let text = formatOrderStatusText(latest, liffId);
    if (orders.length > 1) {
      text += `\n\n(คุณมีทั้งหมด ${orders.length} ออเดอร์ พิมพ์เลขออเดอร์ เช่น ${orders[1].orderId} เพื่อดูออเดอร์อื่นได้ค่ะ)`;
    }
    await lineReply(replyToken, [{ type: "text", text }], accessToken);
  } catch (e) {
    console.error("Tracking reply error:", e);
    await lineReply(replyToken, [{ type: "text", text: "ขอโทษค่ะ ระบบเช็คสถานะขัดข้องชั่วคราว ลองใหม่อีกครั้งนะคะ 🙏" }], accessToken);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("Monly Jelly webhook is alive ✅");
    return;
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-line-signature"];
  const secret = process.env.LINE_CHANNEL_SECRET;

  // 🔓 ทางลัดชั่วคราว: ตั้งค่า SKIP_SIGNATURE_CHECK=true ใน Vercel ถ้าอยาก
  // ให้ webhook ทำงานได้ก่อนโดยไม่เช็ค signature (ใช้แก้ขัดตอนดีบักเท่านั้น
  // ไม่ควรเปิดทิ้งไว้ถาวร เพราะจะมีคนปลอมข้อความส่งเข้ามาที่ endpoint นี้ได้)
  // ค่าเริ่มต้น (ไม่ตั้งค่านี้เลย) = เช็ค signature ตามปกติ ปลอดภัยเหมือนเดิม
  const skipCheck = process.env.SKIP_SIGNATURE_CHECK === "true";

  if (!skipCheck && (!signature || !secret || !verifySignature(rawBody, signature, secret))) {
    // Log แบบละเอียดเพื่อช่วยหาสาเหตุ (ไม่เปิดเผยค่า secret จริง เพื่อความปลอดภัย)
    console.error("Webhook signature verification failed:", {
      hasSignatureHeader: !!signature,
      hasSecretConfigured: !!secret,
      secretLength: secret ? secret.length : 0,
      bodyLength: rawBody ? rawBody.length : 0,
      receivedSignature: signature || "(ไม่มี header มาเลย)",
    });
    res.status(401).json({ error: "invalid signature" });
    return;
  }
  if (skipCheck) {
    console.warn("⚠️ SKIP_SIGNATURE_CHECK เปิดอยู่ — ข้ามการตรวจสอบ signature ชั่วคราว (ไม่ปลอดภัยเต็มที่ ควรปิดโดยเร็ว)");
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    // แม้ parse ไม่ได้ ก็ต้องตอบ 200 กลับ LINE เสมอ (กัน LINE คิดว่า webhook พัง)
    res.status(200).send("OK");
    return;
  }

  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const liffId = process.env.LIFF_ID || "";
  const events = body.events || [];

  for (const event of events) {
    try {
      const userId = event.source && event.source.userId;
      if (!userId) continue;

      // ── log ทุกครั้งที่มีใครส่งข้อความ/กดติดตามร้าน เอาไว้เช็ค userId ง่ายๆ ──
      // (สะดวกกว่า my-line-id.html เพราะไม่ต้องพึ่ง LIFF เลย — แค่ทัก LINE OA
      // ของร้านมา 1 ข้อความ แล้วเข้า Vercel → Runtime Logs หา userId ตรงนี้ได้เลย
      // เอาไปตั้งค่า ADMIN_LINE_USER_IDS ได้ทันที)
      console.log(`[LINE event] type=${event.type} userId=${userId}`);

      // ── ลูกค้ากด "Add Friend" ────────────────────────────────
      if (event.type === "follow") {
        const profile = await lineGetProfile(userId, accessToken);
        const existingRaw = await kv.get(`customer:${userId}`);
        // ป้องกันเคสข้อมูลเก่าที่อาจเผลอถูกเก็บเป็น string มาก่อน (เช่นจากบั๊กเก่าตอนแก้โปรไฟล์)
        const existing = existingRaw ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) : {};
        const customer = {
          ...existing,
          userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          statusMessage: profile.statusMessage || "",
          followedAt: existing.followedAt || new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          isFollowing: true,
        };
        await kv.set(`customer:${userId}`, customer);
        await kv.sadd("customers:index", userId);

        await lineReply(
          event.replyToken,
          [
            {
              type: "text",
              text: `สวัสดีค่ะ คุณ${profile.displayName}! 🍬\nยินดีต้อนรับสู่ Monly Jelly\nขนมเพื่อสุขภาพจากวัตถุดิบธรรมชาติแท้ 🌿`,
            },
            {
              type: "template",
              altText: "เริ่มสั่งซื้อกับ Monly Jelly",
              template: {
                type: "buttons",
                title: "Monly Jelly Pre-Order",
                text: "มีให้เลือก 3 รส + ซองรวม\nBeetRoot / Matcha / Butterfly Pea",
                actions: [
                  { type: "uri", label: "🛒 จองสินค้าเลย", uri: `https://liff.line.me/${liffId}` },
                ],
              },
            },
          ],
          accessToken
        );
      }

      // ── ลูกค้ากด Unfollow / Block ─────────────────────────────
      if (event.type === "unfollow") {
        const existingRaw = await kv.get(`customer:${userId}`);
        const existing = existingRaw ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) : {};
        await kv.set(`customer:${userId}`, {
          ...existing,
          isFollowing: false,
          unfollowedAt: new Date().toISOString(),
        });
      }

      // ── ลูกค้ากดปุ่ม Postback (เช่น ปุ่ม "ลงทะเบียนรับสิทธิ์สมาชิก" ใน
      //    ข้อความ Broadcast ที่ส่งไปหาเพื่อนเก่าทั้งหมด) ──────────────
      //    สำคัญ: ใช้แทนการดึงรายชื่อเพื่อนแบบ bulk (ซึ่งต้องเป็นบัญชี
      //    Verified/Premium เท่านั้น) — Postback event ใช้ได้กับทุกบัญชี
      //    ไม่ว่าจะ verified หรือไม่ เพราะเป็นแค่การตอบกลับข้อความปกติ ที่มี
      //    userId แนบมาด้วยเสมอ (เหมือนตอนลูกค้าพิมพ์ข้อความมาปกติ)
      if (event.type === "postback" && event.postback && event.postback.data === "action=register_member") {
        const profile = await lineGetProfile(userId, accessToken);
        const existingRaw = await kv.get(`customer:${userId}`);
        const existing = existingRaw ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) : {};
        const customer = {
          ...existing,
          userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          statusMessage: profile.statusMessage || "",
          followedAt: existing.followedAt || new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          isFollowing: true,
          registeredVia: "postback_broadcast", // audit trail แยกจาก follow ปกติ/backfill
        };
        await kv.set(`customer:${userId}`, customer);
        await kv.sadd("customers:index", userId);

        await lineReply(
          event.replyToken,
          [{ type: "text", text: `ลงทะเบียนสำเร็จแล้วค่ะ คุณ${profile.displayName}! 🎉\nตอนนี้พร้อมรับสิทธิ์สมาชิกครบทุกอย่างแล้วนะคะ 💚` }],
          accessToken
        );
      }

      // ── ลูกค้าส่งข้อความ (auto-reply คำสำคัญ) ────────────────
      if (event.type === "message" && event.message.type === "text") {
        // ── ลงทะเบียน/อัปเดตโปรไฟล์ลูกค้าไว้ทุกครั้งที่มีคนทักมา ──
        // สำคัญมาก: นี่คือทางออกสำหรับบัญชี Unverified ที่เรียก API ดึง
        // รายชื่อเพื่อนทั้งหมดไม่ได้ — ทุกครั้งที่เพื่อนเก่าคนไหนทักมาคุยกับ
        // ร้านด้วยเหตุผลอะไรก็ตาม (ถามราคา, ถามสถานะ, ทักทายเฉยๆ) ระบบจะจับ
        // LINE ID มาลงทะเบียนให้อัตโนมัติทันที ไม่ต้องรอ Broadcast หรือให้
        // กดปุ่มพิเศษอะไรเลย เป็นวิธี "แบบธรรมชาติ" ที่ค่อยๆ จับเพื่อนเก่า
        // มาลงทะเบียนได้เองไปเรื่อยๆ ตามที่แต่ละคนทักเข้ามาจริง
        try {
          const profile = await lineGetProfile(userId, accessToken);
          const existingRaw = await kv.get(`customer:${userId}`);
          const existing = existingRaw ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) : {};
          await kv.set(`customer:${userId}`, {
            ...existing,
            userId,
            displayName: profile.displayName,
            pictureUrl: profile.pictureUrl,
            statusMessage: profile.statusMessage || "",
            followedAt: existing.followedAt || new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            isFollowing: true,
            registeredVia: existing.registeredVia || "message", // ไม่เขียนทับถ้ามีที่มาอยู่แล้ว
          });
          await kv.sadd("customers:index", userId);
        } catch (e) {
          console.error("Auto-register on message failed:", e);
          // ไม่ throw ต่อ — ยังต้องตอบข้อความปกติต่อไปได้ แม้บันทึกโปรไฟล์ไม่สำเร็จ
        }

        const text = event.message.text.trim();

        // "ติดตาม" หรือ "MJ-xxxxxx" → เช็คสถานะออเดอร์จริงจากฐานข้อมูล
        const orderIdMatch = text.toUpperCase().match(/MJ-[A-Z0-9]{4,8}/);
        if (text.includes("ติดตาม") || orderIdMatch) {
          await handleTrackingReply(event.replyToken, userId, orderIdMatch ? orderIdMatch[0] : null, accessToken, liffId);
          continue;
        }

        const keywords = {
          "สั่ง": `🛒 กดลิงก์นี้เพื่อจองเลยค่ะ\nhttps://liff.line.me/${liffId}`,
          "ราคา": `ราคาสินค้า Monly Jelly 💕\n🧃 แยกรส (6 ชิ้น) = ฿${REFERENCE_PRICE_SINGLE}/ซอง\n🎁 ซองรวม 3 รส (12 ชิ้น) = ฿${REFERENCE_PRICE_MIX}/ซอง`,
          "รอบ": `📅 ดูรอบคิวว่างได้ที่\nhttps://liff.line.me/${liffId}?tab=queue`,
        };
        for (const [kw, reply] of Object.entries(keywords)) {
          if (text.includes(kw)) {
            const messages = [{ type: "text", text: reply }];
            // แนบสรุปคูปองไปด้วยทุกคำสำคัญที่เกี่ยวกับการสั่งซื้อ (สั่ง/ราคา/รอบ)
            // เพราะทั้งหมดนี้คือสัญญาณว่าลูกค้ากำลังสนใจจะซื้อของ ไม่ว่าจะถาม
            // ราคาก่อน ถามรอบก่อน หรือพร้อมสั่งเลยก็ตาม ให้เห็นสรุปคูปองที่มี
            // อยู่เสมอ จะได้ไม่พลาดใช้ก่อนหมดอายุ
            const couponSummary = await buildCouponSummary(userId);
            if (couponSummary) messages.unshift({ type: "text", text: couponSummary });
            await lineReply(event.replyToken, messages, accessToken);
            break;
          }
        }
      }
    } catch (err) {
      console.error("Event handling error:", err);
    }
  }

  // ตอบ 200 กลับ LINE หลังประมวลผลครบทุก event แล้วเท่านั้น
  // (สำคัญ: ต้องตอบหลังทำงานเสร็จ ไม่ใช่ก่อน เพราะ Vercel serverless
  //  อาจตัดการทำงานที่ค้างอยู่ทันทีหลังตอบ response กลับไปแล้ว)
  res.status(200).send("OK");
};

// ⚠️ สำคัญมาก: ต้องแนบ .config ตรงนี้ "หลัง" กำหนด module.exports เป็น
// ฟังก์ชันแล้วเท่านั้น (ห้ามเขียนไว้ตอนต้นไฟล์เด็ดขาด เพราะการเขียน
// module.exports = async (req, res) => {...} ด้านบนจะ "เขียนทับ" ของเดิม
// ทิ้งไปหมด ทำให้ .config หายไป — ปิด bodyParser ไม่ได้ผลจริง ทำให้
// Vercel parse body อัตโนมัติไปก่อน อ่าน raw body ไม่ได้ signature จึง
// ตรวจสอบไม่ผ่าน 401 ตลอด ไม่ว่าจะแก้ Environment Variables ยังไงก็ตาม)
module.exports.config = {
  api: { bodyParser: false },
};
