// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Birthday Job (Daily Cron)
// วางไฟล์นี้ที่: /api/birthday-job.js
// ทำงานทุกวัน 00:00 UTC (ตั้งค่า Vercel Cron)
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

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const { getAllPromotions, savePromotions, generateUniquePromoCode, getThailandDateString } = require("../lib/promotions");

// ส่ง LINE notification
async function sendLineNotification(userId, message) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn("LINE token not configured");
    return;
  }

  try {
    // หมายเหตุ: นี่ต้องใช้ LINE Bot API จริง ต้องระบุ userId
    // ตามหลักการ LINE Push API
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [
          {
            type: "text",
            text: message,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Failed to send LINE notification:", response.statusText);
    }
  } catch (err) {
    console.error("Error sending LINE notification:", err);
  }
}

// ตรวจวันเกิดและสร้างคูปอง
async function processbirthdays() {
  console.log("🎂 Starting birthday check...");

  try {
    // ดึงรายชื่อลูกค้าทั้งหมด
    const customersIndex = await kv.smembers("customers:index");
    if (!customersIndex || customersIndex.length === 0) {
      console.log("No customers found");
      return { processed: 0, created: 0 };
    }

    // ใช้วันที่ตามเวลาไทยเสมอ (ไม่พึ่งแค่จังหวะที่ cron รันตรงกับ UTC เที่ยงคืนพอดี)
    // เผื่อมีใครสั่งรันฟังก์ชันนี้เองนอกเวลา cron ปกติ จะได้ยังจับวันเกิดถูกวันอยู่ดี
    const todayMonthDay = getThailandDateString().slice(5); // "MM-DD" จากรูปแบบ YYYY-MM-DD

    // ── ขั้นที่ 1: ดึงข้อมูลลูกค้าทั้งหมดแบบขนาน (เร็วขึ้นมาก รองรับลูกค้าหลักพันคนได้)
    //    แบ่งเป็นชุดๆ ละ 50 คน กันยิง request พร้อมกันเยอะเกินไปจนฐานข้อมูลโอเวอร์โหลด
    const BATCH_SIZE = 50;
    const customersWithBirthdayToday = [];

    for (let i = 0; i < customersIndex.length; i += BATCH_SIZE) {
      const batch = customersIndex.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (userId) => {
          try {
            const customerData = await kv.get(`customer:${userId}`);
            if (!customerData) return null;
            const customer = typeof customerData === "string"
              ? JSON.parse(customerData)
              : customerData;
            if (!customer.birthday) return null;
            const [, month, day] = customer.birthday.split("-");
            if (`${month}-${day}` !== todayMonthDay) return null;
            return { userId, customer };
          } catch (e) {
            console.error(`Error checking ${userId}:`, e);
            return null;
          }
        })
      );
      for (const r of results) if (r) customersWithBirthdayToday.push(r);
    }

    let processed = 0;
    let created = 0;

    // ── ขั้นที่ 2: สร้างคูปอง + ส่ง LINE ให้เฉพาะคนที่วันเกิดตรงวันนี้เท่านั้น
    //    (จำนวนคนกลุ่มนี้ปกติน้อยมาก ทำทีละคนแบบเดิมได้ ไม่กระทบความเร็ว)
    for (const { userId, customer } of customersWithBirthdayToday) {
      try {
        console.log(`🎂 Birthday found: ${customer.name} (${userId})`);

          // ตรวจว่ายังไม่ได้สร้างคูปองวันนี้
          const couponsData = await kv.get(`coupons:${userId}`);
          const coupons = couponsData 
            ? (typeof couponsData === "string" 
              ? JSON.parse(couponsData) 
              : couponsData)
            : [];

          const todayDate = getThailandDateString();
          // สำคัญ: เช็คเฉพาะ "คูปองวันเกิด" เท่านั้น (source ไม่ใช่ loyalty/game)
          // ไม่งั้นถ้าลูกค้าเล่นเกมหรือได้รางวัลสะสมแต้มในวันเกิดตัวเองพอดี
          // ระบบจะเข้าใจผิดว่า "มีคูปองสร้างวันนี้แล้ว" แล้วข้ามไม่ออกคูปองวันเกิดให้เลย
          const alreadyCreated = coupons.some(
            (c) => (!c.source || c.source === "birthday") && getThailandDateString(c.createdAt) === todayDate
          );

          if (!alreadyCreated) {
            // ใช้ค่าที่ลูกค้าตั้งไว้ล่วงหน้า ถ้าไม่มี → ใช้ค่า default
            const theme = customer.couponTheme || "pastel-rainbow";
            const greeting = customer.couponGreeting || `🎂 Happy Birthday, ${customer.name}!`;
            const fontSize = customer.couponFontSize || "medium";
            const textColor = customer.couponTextColor || "";
            const couponId = `cpn-birthday-${userId}-${Date.now()}`;

            // ── สร้างโค้ดส่วนลดก่อน แล้วลงทะเบียนเข้าระบบโปรโมชั่นกลาง ──
            // (รวมเป็นระบบเดียวกับโปรโมชั่นทั่วไป) ล็อกไว้ว่าใช้ได้เฉพาะ
            // เจ้าของคูปองคนนี้เท่านั้น ใช้ได้แค่ 1 ครั้ง หมดอายุใน 30 วัน
            const promoCode = await generateUniquePromoCode("BDAY");
            const expiresIn30Days = new Date();
            expiresIn30Days.setDate(expiresIn30Days.getDate() + 30);

            const promotions = await getAllPromotions();
            promotions.push({
              code: promoCode,
              type: "fixed",
              value: 20,
              startDate: null,
              endDate: expiresIn30Days.toISOString().slice(0, 10),
              minOrderValue: 0,
              maxUses: 1,
              usedCount: 0,
              active: true,
              restrictedToUserId: userId,     // ใช้ได้เฉพาะเจ้าของคนนี้
              linkedCouponId: couponId,       // ไว้ sync สถานะ "ใช้แล้ว" กลับไปที่คูปอง
              createdAt: new Date().toISOString(),
              createdBy: "ระบบอัตโนมัติ (วันเกิด)",
            });
            await savePromotions(promotions);

            const coupon = {
              id: couponId,
              userId,
              source: "birthday", // ระบุชัดเจน แยกจาก loyalty/game ที่อยู่ใน array เดียวกัน
              theme,
              greeting,
              fontSize,
              textColor,
              profileImg: customer.avatar || "",
              createdAt: new Date().toISOString(),
              usedAt: null,
              usedInOrderId: null,
              auto_generated: true, // ← ทำเครื่องหมายว่าสร้างอัตโนมัติ
              code: promoCode,      // โค้ดที่ลูกค้าใช้กรอกตอนสั่งซื้อ
            };

            coupons.push(coupon);
            await kv.set(`coupons:${userId}`, JSON.stringify(coupons));

            // ส่ง LINE notification (บอกโค้ดที่ใช้กรอกตอนสั่งซื้อจริงๆ)
            const message = `🎉 วันเกิดสุขสันต์ ${customer.name}! 🎂\n\nคุณได้รับส่วนลด 20 บาท!\n\n🎟️ โค้ด: ${promoCode}\nใช้ได้ภายใน 30 วัน (ใช้ได้ 1 ครั้ง)\n\nนำโค้ดนี้ไปกรอกในช่อง "โค้ดส่วนลด" ตอนสั่งซื้อได้เลยค่ะ 💚`;
            await sendLineNotification(userId, message);

            created++;
            console.log(`✅ Coupon created for ${customer.name} (code: ${promoCode})`);
          } else {
            console.log(`⏭️ Coupon already created today for ${customer.name}`);
          }

          processed++;
      } catch (err) {
        console.error(`Error processing ${userId}:`, err);
      }
    }

    console.log(`✅ Birthday check completed: ${processed} processed, ${created} coupons created`);
    return { processed, created };
  } catch (err) {
    console.error("Birthday job error:", err);
    throw err;
  }
}

// Vercel Cron handler
module.exports = async (req, res) => {
  // ยืนยันว่า request มาจาก Vercel Cron จริง โดยใช้ CRON_SECRET
  // (วิธีทางการที่ Vercel เอกสารแนะนำ — Vercel จะส่ง Authorization: Bearer <CRON_SECRET>
  //  มาให้อัตโนมัติ ถ้าตั้งค่าตัวแปร CRON_SECRET ไว้ใน Environment Variables)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  // หมายเหตุ: ถ้ายังไม่ได้ตั้งค่า CRON_SECRET ไว้ จะข้ามการเช็คนี้ไปเลย
  // (ใช้งานได้ปกติ แต่แนะนำให้ตั้งค่าไว้เพื่อความปลอดภัย กันคนนอกยิง request มาเรียกเอง)

  try {
    const result = await processbirthdays();
    res.status(200).json({
      success: true,
      message: "Birthday job completed",
      ...result,
    });
  } catch (err) {
    console.error("Birthday job error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};
