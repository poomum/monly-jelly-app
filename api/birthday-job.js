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
    return false;
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
      return false;
    }
    return true;
  } catch (err) {
    console.error("Error sending LINE notification:", err);
    return false;
  }
}

// ── แจ้งเตือนล่วงหน้าก่อนวันเกิด ──
// แจ้งเตือนล่วงหน้าแค่ 1 ครั้ง: 1 วันก่อนวันเกิดเท่านั้น (ลูกค้าแต่ละคนได้ปีละ 1 ครั้ง)
const BIRTHDAY_REMINDER_DAYS_BEFORE = 1;
// ย้อนเก็บตกวันเกิดที่ระบบพลาดส่งได้ไม่เกินกี่วัน (ดูคำอธิบายใน processbirthdays)
const BIRTHDAY_CATCHUP_DAYS = 7;
const SITE_BASE = "https://monly-jelly-application.vercel.app";

function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

// คืนค่า "MM-DD" ของวันเกิดที่ใช้เทียบในปีที่กำหนด
// สำคัญ (แก้ล่วงหน้า): คนเกิด 29 ก.พ. ปีที่ไม่ใช่ปีอธิกสุรทินจะไม่มีวันที่ 29 เลย
// เดิมจะไม่ได้คูปองวันเกิดเลย 3 ปีจาก 4 ปี — ปีแบบนี้ให้นับเป็น 28 ก.พ. แทน
function birthdayMonthDayForYear(birthday, year) {
  const parts = String(birthday || "").split("-");
  if (parts.length < 3) return null;
  const md = `${parts[1]}-${parts[2].slice(0, 2)}`;
  if (md === "02-29" && !isLeapYear(year)) return "02-28";
  return md;
}

function parseCustomer(raw) {
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// ── ข้อความสุขสันต์วันเกิด + เงื่อนไขการใช้คูปอง ──
// เงื่อนไขทุกข้อตรงกับที่ระบบบังคับใช้จริง (ดู promotions ที่สร้างด้านล่าง +
// checkPromoValidity/reclaimPromoUsage ใน lib/promotions.js) ถ้าแก้กติกาฝั่งระบบ
// ต้องมาแก้ข้อความตรงนี้ให้ตรงกันด้วย
function formatThaiDate(date) {
  try {
    return new Date(date).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric" });
  } catch (e) {
    return getThailandDateString(date);
  }
}

// คำอวยพรเริ่มต้น (ใช้เมื่อลูกค้าไม่ได้ตั้งคำอวยพรเองในหน้า "ตั้งคูปองวันเกิด")
// โทนอบอุ่น เป็นกันเอง — ระบบเลือกให้ 1 แบบต่อคนต่อปี (คงที่ ไม่สุ่มใหม่ถ้ารันซ้ำ)
// เพิ่ม/แก้ข้อความได้ที่นี่เลย ใช้ {name} แทนชื่อลูกค้า
const DEFAULT_BIRTHDAY_WISHES = [
  {
    title: "Happy Birthday น้าา คุณ{name}",
    body: "โตขึ้นอีกปีแล้วนะ อย่าดื้อ อย่าซน และรักษาสุขภาพด้วยนะ เราอยู่ข้างๆ แกเสมอ ❤️✌🏻",
  },
  {
    title: "Happy Birthday นะ คุณ{name}",
    body: "ขอให้ปีนี้มีแต่เรื่องดีๆ หวานๆ เหมือนเยลลี่ ยิ้มเยอะๆ สุขภาพแข็งแรง และสมหวังทุกเรื่องเลยน้าา 🍬💕",
  },
  {
    title: "สุขสันต์วันเกิดน้าา คุณ{name}",
    body: "อายุเพิ่มขึ้นแต่ความน่ารักไม่ลดลงเลยนะ 😆 ขอให้มีความสุขมากๆ กินอิ่ม นอนหลับ ไม่เครียด แล้วแวะมาหาเราบ่อยๆ นะ 💚",
  },
];

function pickDefaultWish(seed) {
  let h = 0;
  for (const ch of String(seed || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return DEFAULT_BIRTHDAY_WISHES[h % DEFAULT_BIRTHDAY_WISHES.length];
}

function buildBirthdayMessage({ name, greeting, decorations, promoCode, expiresAt, userId, belated }) {
  const displayName = name || "ลูกค้า";
  const decoLine = decorations && decorations.length ? `${decorations.join(" ")}\n\n` : "";
  let opening;
  if (greeting) {
    // ลูกค้าตั้งคำอวยพรเองไว้ล่วงหน้า → ใช้ของลูกค้า
    opening = `🎉 สุขสันต์วันเกิดนะ คุณ${displayName}! 🎂\n\n💌 ${String(greeting).slice(0, 300)}\n\n`;
  } else {
    const year = getThailandDateString().slice(0, 4);
    const wish = pickDefaultWish(`${userId || displayName}:${year}`);
    opening = `🎂 ${wish.title.replace("{name}", displayName)} 🎉\n\n${wish.body}\n\n`;
  }
  // ส่งย้อนหลัง (ระบบไม่ได้ส่งให้ตรงวันเกิด) → ขอโทษลูกค้าสั้นๆ ก่อน
  const belatedLine = belated ? `🙏 ขอโทษที่ส่งช้าไปหน่อยนะ สุขสันต์วันเกิดย้อนหลังน้าา\n\n` : "";
  return (
    decoLine +
    belatedLine +
    opening +
    `🎁 Monly Jelly มอบส่วนลด 20 บาท เป็นของขวัญวันเกิดให้นะ\n\n` +
    `🎟️ โค้ด: ${promoCode}\n\n` +
    `📌 เงื่อนไขการใช้งาน\n` +
    `• ส่วนลด 20 บาท ใช้ได้ 1 ครั้ง\n` +
    `• ใช้ได้ถึงวันที่ ${formatThaiDate(expiresAt)}\n` +
    `• ใช้ได้เฉพาะบัญชี LINE นี้เท่านั้น โอนให้ผู้อื่นไม่ได้\n` +
    `• ไม่มียอดสั่งซื้อขั้นต่ำ\n` +
    `• ใช้ได้ 1 โค้ดต่อ 1 ออเดอร์ ใช้ร่วมกับโค้ดส่วนลดอื่นไม่ได้\n` +
    `• แลกเปลี่ยนเป็นเงินสดไม่ได้\n` +
    `• หากยกเลิกออเดอร์ที่ใช้โค้ดนี้ จะได้สิทธิ์ใช้โค้ดคืน\n\n` +
    `💡 วิธีใช้: กรอกโค้ดในช่อง "โค้ดส่วนลด" ตอนสั่งซื้อ\n` +
    `ดูคูปองได้ที่เมนู "คูปองของฉัน" 💚`
  );
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
    // สำคัญ (แก้ล่วงหน้า): ไม่ได้ดูแค่ "วันนี้" แต่ย้อนดูวันเกิดที่ผ่านมาไม่เกิน
    // BIRTHDAY_CATCHUP_DAYS วันด้วย — ถ้าระบบล่ม/งานประจำวันไม่ได้รันในวันเกิดของลูกค้า
    // (เคยเกิดขึ้นจริง: ไฟล์ระบบถูกลบออกจาก GitHub ค้างไว้ 3 วัน) ลูกค้าคนนั้นจะยังได้
    // คูปองวันเกิดย้อนหลังในรอบถัดไปที่ระบบกลับมาทำงาน ไม่ต้องรอถึงปีหน้า
    const birthdayWindow = new Map(); // "MM-DD|ปี" ของแต่ละวันในช่วงย้อนหลัง → ผ่านมากี่วัน
    for (let d = 0; d <= BIRTHDAY_CATCHUP_DAYS; d++) {
      const dateStr = getThailandDateString(new Date(Date.now() - d * 24 * 60 * 60 * 1000));
      birthdayWindow.set(dateStr.slice(5) + "|" + dateStr.slice(0, 4), d);
    }
    const matchBirthday = (birthday) => {
      let best = null;
      for (const [key, daysAgo] of birthdayWindow) {
        const [md, year] = key.split("|");
        if (birthdayMonthDayForYear(birthday, parseInt(year, 10)) === md) {
          if (best === null || daysAgo < best) best = daysAgo;
        }
      }
      return best; // null = ไม่อยู่ในช่วง, 0 = วันนี้, >0 = ผ่านมาแล้วกี่วัน
    };

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
            if (customer.mergedInto) return null; // บัญชีเก่าที่รวมไปแล้ว — ส่งที่บัญชีปัจจุบันเท่านั้น
            const daysAgo = matchBirthday(customer.birthday);
            if (daysAgo === null) return null;
            return { userId, customer, daysAgo };
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
    for (const { userId, customer, daysAgo } of customersWithBirthdayToday) {
      try {
        console.log(`🎂 Birthday found: ${customer.name} (${userId})`);

          // ตรวจว่ายังไม่ได้สร้างคูปองวันนี้
          const couponsData = await kv.get(`coupons:${userId}`);
          const coupons = couponsData 
            ? (typeof couponsData === "string" 
              ? JSON.parse(couponsData) 
              : couponsData)
            : [];

          // กันออกซ้ำ: ลูกค้า 1 คนได้คูปองวันเกิดได้ 1 ใบต่อรอบปีเท่านั้น
          // (เช็คจากคูปองวันเกิดใบล่าสุดว่าออกไปภายใน 300 วันที่ผ่านมาหรือยัง — ครอบคลุม
          // ทั้งกรณีรันซ้ำวันเดียวกัน และกรณีย้อนหลังที่ลูกค้าได้คูปองตรงวันไปแล้ว)
          // เช็คเฉพาะ "คูปองวันเกิด" เท่านั้น (source ไม่ใช่ loyalty/game/personal)
          const DEDUPE_MS = 300 * 24 * 60 * 60 * 1000;
          const alreadyCreated = coupons.some(
            (c) => c && (!c.source || c.source === "birthday") && c.createdAt &&
              Date.now() - new Date(c.createdAt).getTime() < DEDUPE_MS
          );

          if (!alreadyCreated) {
            // ใช้ค่าที่ลูกค้าตั้งไว้ล่วงหน้า ถ้าไม่มี → ใช้ค่า default
            const theme = customer.couponTheme || "pastel-rainbow";
            const greeting = customer.couponGreeting || `🎂 Happy Birthday, ${customer.name}!`;
            const fontSize = customer.couponFontSize || "medium";
            const textColor = customer.couponTextColor || "";
            const fontFamily = customer.couponFontFamily || "'Mitr',sans-serif";
            const decorations = Array.isArray(customer.couponDecorations) ? customer.couponDecorations : [];
            const couponId = `cpn-birthday-${userId}-${Date.now()}`;

            // ── สร้างโค้ดส่วนลดก่อน แล้วลงทะเบียนเข้าระบบโปรโมชั่นกลาง ──
            // (รวมเป็นระบบเดียวกับโปรโมชั่นทั่วไป) ล็อกไว้ว่าใช้ได้เฉพาะ
            // เจ้าของคูปองคนนี้เท่านั้น ใช้ได้แค่ 1 ครั้ง หมดอายุใน 3 เดือน
            // (ให้เวลาลืมใช้ตอนวันเกิดจริงได้บ้าง) — ถ้าหมดอายุแล้วไม่ได้ใช้
            // เลย ต้องรอวันเกิดรอบถัดไปถึงจะได้คูปองใหม่ (ระบบเช็คจากวันที่
            // สร้างคูปองครั้งล่าสุด ไม่ใช่จากวันหมดอายุ จึงออกให้ปีละ 1 ครั้ง
            // เท่านั้นอยู่แล้วโดยธรรมชาติ ไม่ต้องแก้จุดอื่นเพิ่ม)
            const promoCode = await generateUniquePromoCode("BDAY");
            const expiresIn3Months = new Date();
            expiresIn3Months.setMonth(expiresIn3Months.getMonth() + 3);

            const promotions = await getAllPromotions();
            promotions.push({
              code: promoCode,
              type: "fixed",
              value: 20,
              startDate: null,
              endDate: expiresIn3Months.toISOString().slice(0, 10),
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
              fontFamily,
              decorations,
              profileImg: customer.avatar || "",
              createdAt: new Date().toISOString(),
              expiresAt: expiresIn3Months.toISOString(), // ให้ตรงกับ endDate ของโปรโมชั่นเป๊ะ หน้าเว็บจะได้แสดงวันหมดอายุถูกต้อง
              usedAt: null,
              usedInOrderId: null,
              auto_generated: true, // ← ทำเครื่องหมายว่าสร้างอัตโนมัติ
              code: promoCode,      // โค้ดที่ลูกค้าใช้กรอกตอนสั่งซื้อ
            };

            coupons.push(coupon);
            await kv.set(`coupons:${userId}`, JSON.stringify(coupons));

            // ส่ง LINE notification (บอกโค้ดที่ใช้กรอกตอนสั่งซื้อจริงๆ)
            const message = buildBirthdayMessage({
              name: customer.name,
              greeting: customer.couponGreeting,
              decorations,
              promoCode,
              expiresAt: expiresIn3Months,
              userId,
              belated: daysAgo > 0,
            });
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

// ── เตือนลูกค้าที่ยังไม่ชำระเงิน (เผลอออกจากหน้าจ่ายเงินไปก่อนโอน) ──
// เช็คทุกวัน (รันพร้อม cron เดียวกับงานวันเกิด) หาออเดอร์ที่ยังค้างสถานะ
// "pending_payment" นานเกิน REMINDER_AFTER_HOURS ชั่วโมง แล้วยังไม่เคยเตือนมา
// ก่อน (เช็คจาก paymentReminderSent กันเตือนซ้ำทุกวันจนน่ารำคาญ) — ส่งแจ้งเตือน
// เบาๆ ให้นึกขึ้นได้ว่ายังไม่ได้โอนเงิน พร้อมลิงก์กลับไปหน้าจ่ายเงินเดิม
const REMINDER_AFTER_HOURS = 24; // เตือนถ้าค้างเกิน 24 ชม.
async function checkPendingPaymentReminders() {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const liffId = process.env.LIFF_ID;
  if (!accessToken) return { checked: false, reason: "ไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ไว้" };

  const orderIds = (await kv.smembers("orders:index")) || [];
  let reminded = 0;
  let checked = 0;

  for (const orderId of orderIds) {
    const raw = await kv.get(`order:${orderId}`);
    if (!raw) continue;
    const order = typeof raw === "string" ? JSON.parse(raw) : raw;

    if (order.status !== "pending_payment") continue;
    if (!order.userId) continue; // ไม่มี LINE ID ให้ส่งไปหาไม่ได้ ข้าม (guest order)
    if (order.paymentReminderSent) continue; // เตือนไปแล้วครั้งเดียวพอ ไม่สแปมซ้ำทุกวัน

    checked++;
    const hoursSinceCreated = (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreated < REMINDER_AFTER_HOURS) continue;

    const trackLink = liffId ? `https://liff.line.me/${liffId}?orderId=${orderId}` : null;
    const message =
      `💌 แจ้งเตือนเบาๆ ค่ะ\n\n` +
      `ออเดอร์ #${orderId} ของคุณยังไม่ได้ชำระเงินเลยนะคะ\n` +
      `💰 ยอดที่ต้องโอน: ฿${order.grandTotal}\n\n` +
      `เผลอปิดหน้าจ่ายเงินไปหรือเปล่าคะ? 😊 ถ้าพร้อมแล้ว กดลิงก์นี้กลับไปชำระได้เลย:\n` +
      (trackLink ? trackLink : `พิมพ์ "ติดตาม" ในแชทนี้เพื่อกลับไปหน้าจ่ายเงินได้เลยค่ะ`) +
      `\n\nถ้าไม่ต้องการสั่งซื้อแล้ว ไม่ต้องทำอะไรเพิ่มนะคะ 💚`;

    const sent = await sendLineNotification(order.userId, message);
    if (sent) {
      order.paymentReminderSent = true;
      order.paymentReminderSentAt = new Date().toISOString();
      await kv.set(`order:${orderId}`, order);
      reminded++;
    }
  }

  return { checked, reminded };
}

// ── เตือนล่วงหน้า 1 วันก่อนวันเกิด ──
// บอกลูกค้าว่าจะได้คูปองวันเกิด + ชวนไปตั้งธีม/คำอวยพรของคูปองไว้ล่วงหน้า
async function checkUpcomingBirthdayReminders() {
  if (!BIRTHDAY_REMINDER_DAYS_BEFORE) return { enabled: false };
  if (!LINE_CHANNEL_ACCESS_TOKEN) return { enabled: true, sent: 0, reason: "ไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ไว้" };

  const target = getThailandDateString(new Date(Date.now() + BIRTHDAY_REMINDER_DAYS_BEFORE * 24 * 60 * 60 * 1000));
  const targetYear = parseInt(target.slice(0, 4), 10);
  const targetMonthDay = target.slice(5);

  const ids = (await kv.smembers("customers:index")) || [];
  let sent = 0;
  const BATCH_SIZE = 50;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const found = await Promise.all(batch.map(async (userId) => {
      try {
        const c = parseCustomer(await kv.get(`customer:${userId}`));
        if (!c || !c.birthday) return null;
        if (c.mergedInto) return null; // บัญชีเก่าที่รวมไปแล้ว — เตือนที่บัญชีปัจจุบันเท่านั้น
        if (birthdayMonthDayForYear(c.birthday, targetYear) !== targetMonthDay) return null;
        return { userId, c };
      } catch (e) { console.error(`reminder check ${userId}:`, e); return null; }
    }));

    for (const r of found) {
      if (!r) continue;
      const { userId, c } = r;
      if (!/^U/.test(userId)) continue; // guest ไม่มี LINE ให้ส่ง
      // กันส่งซ้ำ: 1 ครั้งต่อคนต่อปี
      const sentKey = `birthday-reminder-sent:${userId}:${targetYear}`;
      if (await kv.get(sentKey)) continue;

      const hasSetup = !!(c.couponTheme || c.couponGreeting);
      const setupLink = `${SITE_BASE}/coupon-customizer.html?userId=${encodeURIComponent(userId)}`;
      const name = c.name || "คุณลูกค้า";
      const message =
        `🎂 พรุ่งนี้เป็นวันเกิดของ ${name} แล้วนะคะ!\n\n` +
        `🎁 ในวันเกิด คุณจะได้รับคูปองส่วนลด 20 บาท ส่งให้ทางแชทนี้อัตโนมัติค่ะ\n\n` +
        (hasSetup
          ? `💌 คำอวยพร/ธีมคูปองที่คุณตั้งไว้พร้อมแล้ว อยากแก้ไขก่อนถึงวันจริง กดที่นี่ได้เลย:\n${setupLink}`
          : `✨ ตั้งธีมและคำอวยพรบนคูปองวันเกิดของคุณไว้ล่วงหน้าได้เลย:\n${setupLink}`) +
        `\n\nMonly Jelly รอฉลองกับคุณนะคะ 💚`;

      const ok = await sendLineNotification(userId, message);
      if (ok) {
        await kv.set(sentKey, "1", { ex: 60 * 60 * 24 * 60 }); // เก็บ 60 วันพอ
        sent++;
      }
    }
  }
  return { enabled: true, daysBefore: BIRTHDAY_REMINDER_DAYS_BEFORE, targetDate: target, sent };
}

// Vercel Cron handler
// ── เตือนก่อน SlipOK หมดอายุ ──
// เช็ควันต่ออายุที่แอดมินตั้งไว้เอง (ผ่าน environment variable SLIPOK_RENEWAL_DATE
// รูปแบบ YYYY-MM-DD เช่น "2026-09-12") เทียบกับวันนี้ ถ้าเหลือ 5 วันหรือน้อยกว่า
// ให้ส่งเตือนแอดมินทาง LINE — ถ้าไม่ได้ตั้งค่าตัวแปรนี้ไว้เลย จะข้ามการเช็คนี้ไป
// เฉยๆ ไม่ error อะไร (เป็นฟีเจอร์เสริม ไม่ใช่สิ่งที่บังคับต้องตั้งค่า)
async function checkSlipOkRenewalReminder() {
  const renewalDateStr = process.env.SLIPOK_RENEWAL_DATE;
  if (!renewalDateStr) return { checked: false, reason: "ไม่ได้ตั้งค่า SLIPOK_RENEWAL_DATE ไว้" };

  const today = getThailandDateString();
  const daysUntilRenewal = Math.ceil((new Date(renewalDateStr) - new Date(today)) / (1000 * 60 * 60 * 24));

  // เตือนแค่ตอนเหลือ 5 วันหรือน้อยกว่า (แต่ยังไม่ติดลบเกินไป กันเตือนซ้ำไปเรื่อยๆ
  // ทุกวันหลังจากวันที่ตั้งไว้ผ่านไปแล้วนานมาก)
  if (daysUntilRenewal > 5 || daysUntilRenewal < -3) {
    return { checked: true, daysUntilRenewal, alerted: false };
  }

  // กันเตือนซ้ำวันเดียวกัน (เผื่อ cron รันมากกว่า 1 ครั้งต่อวันด้วยเหตุผลใดก็ตาม)
  const alertedTodayKey = `slipok:renewal-reminder-sent:${today}`;
  const alreadySentToday = await kv.get(alertedTodayKey);
  if (alreadySentToday) return { checked: true, daysUntilRenewal, alerted: false, reason: "เตือนไปแล้ววันนี้" };

  const adminLineIds = (process.env.ADMIN_LINE_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (LINE_CHANNEL_ACCESS_TOKEN && adminLineIds.length > 0) {
    const urgencyEmoji = daysUntilRenewal <= 0 ? "🔴" : daysUntilRenewal <= 2 ? "🟠" : "🟡";
    const daysText = daysUntilRenewal <= 0
      ? `หมดอายุไปแล้ว ${Math.abs(daysUntilRenewal)} วัน`
      : `เหลืออีก ${daysUntilRenewal} วัน`;
    const reminderText =
      `${urgencyEmoji} แจ้งเตือนต่ออายุ SlipOK\n\n` +
      `แพ็กเกจ SlipOK จะ${daysText} (วันที่ตั้งไว้: ${renewalDateStr})\n\n` +
      `👉 อย่าลืมเข้าไปต่ออายุที่ slipok.com นะคะ ไม่งั้นลูกค้าจะแนบสลิปแล้วตรวจสอบอัตโนมัติไม่ได้`;
    for (const adminId of adminLineIds) {
      await sendLineNotification(adminId, reminderText);
    }
    await kv.set(alertedTodayKey, "1", { ex: 60 * 60 * 24 * 2 }); // เก็บไว้ 2 วันพอ
  }
  return { checked: true, daysUntilRenewal, alerted: true };
}

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
    const slipOkReminder = await checkSlipOkRenewalReminder().catch((e) => {
      console.error("SlipOK renewal reminder check failed:", e);
      return { checked: false, error: e.message };
    });
    const birthdayReminders = await checkUpcomingBirthdayReminders().catch((e) => {
      console.error("Birthday reminder check failed:", e);
      return { enabled: true, sent: 0, error: e.message };
    });
    const paymentReminders = await checkPendingPaymentReminders().catch((e) => {
      console.error("Payment reminder check failed:", e);
      return { checked: 0, reminded: 0, error: e.message };
    });
    res.status(200).json({
      success: true,
      message: "Birthday job completed",
      ...result,
      slipOkReminder,
      paymentReminders,
      birthdayReminders,
    });
  } catch (err) {
    console.error("Birthday job error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

module.exports.buildBirthdayMessage = buildBirthdayMessage;
