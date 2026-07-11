// ═══════════════════════════════════════════════════════════════
// Monly Jelly – LINE Webhook (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/webhook.js  (รากโปรเจกต์ ระดับเดียวกับ package.json)
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");
const { kv } = require("@vercel/kv");

// ต้องปิด bodyParser อัตโนมัติของ Vercel เพื่ออ่าน raw body
// มาตรวจลายเซ็นของ LINE (HMAC-SHA256) ให้ถูกต้อง
module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("Monly Jelly webhook is alive ✅");
    return;
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-line-signature"];
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!signature || !secret || !verifySignature(rawBody, signature, secret)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // ตอบ LINE ทันที ภายใน 1 วินาทีเสมอ (ประมวลผลต่อแบบ async หลังจากนี้)
  res.status(200).send("OK");

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return;
  }

  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const liffId = process.env.LIFF_ID || "";
  const events = body.events || [];

  for (const event of events) {
    try {
      const userId = event.source && event.source.userId;
      if (!userId) continue;

      // ── ลูกค้ากด "Add Friend" ────────────────────────────────
      if (event.type === "follow") {
        const profile = await lineGetProfile(userId, accessToken);
        const existing = (await kv.get(`customer:${userId}`)) || {};
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
        const existing = (await kv.get(`customer:${userId}`)) || {};
        await kv.set(`customer:${userId}`, {
          ...existing,
          isFollowing: false,
          unfollowedAt: new Date().toISOString(),
        });
      }

      // ── ลูกค้าส่งข้อความ (auto-reply คำสำคัญ) ────────────────
      if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text.trim();
        const keywords = {
          "สั่ง": `🛒 กดลิงก์นี้เพื่อจองเลยค่ะ\nhttps://liff.line.me/${liffId}`,
          "ราคา": "ราคาสินค้า Monly Jelly 💕\n🧃 แยกรส (6 ชิ้น) = ฿89/ซอง\n🎁 ซองรวม 3 รส (12 ชิ้น) = ฿189/ซอง",
          "รอบ": `📅 ดูรอบคิวว่างได้ที่\nhttps://liff.line.me/${liffId}?tab=queue`,
          "ติดตาม": `📦 ติดตามออเดอร์ได้ที่\nhttps://liff.line.me/${liffId}?tab=track`,
        };
        for (const [kw, reply] of Object.entries(keywords)) {
          if (text.includes(kw)) {
            await lineReply(event.replyToken, [{ type: "text", text: reply }], accessToken);
            break;
          }
        }
      }
    } catch (err) {
      console.error("Event handling error:", err);
    }
  }
};
