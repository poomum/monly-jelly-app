// ═══════════════════════════════════════════════════════════════
// Monly Jelly – ไลบรารีกลางสำหรับระบบโปรโมชั่น/โค้ดส่วนลด
// วางไฟล์นี้ที่: /lib/promotions.js  (นอกโฟลเดอร์ api/ ตามคำแนะนำของ
// Vercel เพื่อไม่ให้ถูกนับเป็น serverless function แยก)
//
// ไฟล์ที่ต้องใช้เรียกผ่าน:
//   const { getAllPromotions, checkPromoValidity, calcDiscount } =
//     require("../lib/promotions");
// ═══════════════════════════════════════════════════════════════

const { kv } = require("./adminAuth");

// ── วันที่ตามเวลาไทย (UTC+7) จาก timestamp ที่ให้มา (หรือเวลาปัจจุบันถ้าไม่ระบุ) ──
// เซิร์ฟเวอร์ (Vercel) รันด้วยเวลา UTC เป็นค่าเริ่มต้นเสมอ ถ้าเทียบวันที่ด้วย
// new Date().toISOString() ตรงๆ จะมีบั๊ก: ช่วงเที่ยงคืน–7โมงเช้าตามเวลาไทย (เพราะ
// ไทย = UTC+7) ปฏิทิน UTC จะยังค้างอยู่ "เมื่อวาน" อยู่ ทำให้โปรโมชั่นที่ตั้ง
// วันเริ่มเป็น "วันนี้" ไม่ทำงานจนกว่าจะเลย 7 โมงเช้าไปแล้ว — ฟังก์ชันนี้แก้ปัญหา
// นี้โดยบวกชดเชย 7 ชั่วโมงก่อนอ่านวันที่ ให้ตรงกับปฏิทินเวลาไทยเสมอ
//
// สำคัญ: ต้องใช้ฟังก์ชันนี้แปลง "ทุก" timestamp ที่จะเอามาเทียบวันที่กัน (ทั้ง
// "วันนี้" และ timestamp ที่เคยบันทึกไว้ เช่น createdAt) ไม่งั้นจะเทียบกันคนละ
// เขตเวลา ได้ผลลัพธ์ผิดเพี้ยนเหมือนเดิม
function getThailandDateString(dateInput) {
  const base = dateInput ? new Date(dateInput) : new Date();
  const thailandTime = new Date(base.getTime() + 7 * 60 * 60 * 1000);
  return thailandTime.toISOString().slice(0, 10);
}

async function getAllPromotions() {
  const data = await kv.get("promotions:all");
  if (!data) return [];
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function savePromotions(list) {
  await kv.set("promotions:all", JSON.stringify(list));
}

// ตรวจสอบโค้ดว่าใช้ได้จริงไหม ณ ตอนนี้ (ใช้ทั้งฝั่งเช็คตอนกรอกโค้ด และ
// ฝั่งคำนวณส่วนลดจริงตอนสั่งซื้อ ต้องเรียกจากที่เดียวกันเพื่อความสอดคล้อง)
// requestingUserId: ใช้เช็คกรณีเป็นคูปองส่วนตัว (เช่น คูปองวันเกิด)
// ที่ล็อกไว้ว่าใช้ได้เฉพาะเจ้าของคนนั้นเท่านั้น
function checkPromoValidity(promo, orderSubtotal, requestingUserId) {
  if (!promo) return { valid: false, error: "ไม่พบโค้ดนี้ในระบบ" };
  if (!promo.active) return { valid: false, error: "โค้ดนี้ถูกปิดใช้งานแล้ว" };

  if (promo.restrictedToUserId && promo.restrictedToUserId !== requestingUserId) {
    return { valid: false, error: "โค้ดนี้เป็นคูปองส่วนตัว ใช้ได้เฉพาะเจ้าของคูปองเท่านั้น" };
  }

  const today = getThailandDateString(); // YYYY-MM-DD (วันที่ปัจจุบันตามเวลาไทย)
  if (promo.startDate && today < promo.startDate) {
    return { valid: false, error: `โค้ดนี้เริ่มใช้ได้วันที่ ${promo.startDate}` };
  }
  if (promo.endDate && today > promo.endDate) {
    return { valid: false, error: "โค้ดนี้หมดอายุแล้ว" };
  }
  if (promo.maxUses != null && promo.usedCount >= promo.maxUses) {
    return { valid: false, error: "โค้ดนี้ถูกใช้ครบจำนวนที่กำหนดแล้ว (คูปองนี้ถูกใช้ไปแล้ว)" };
  }
  if (promo.minOrderValue && orderSubtotal < promo.minOrderValue) {
    return { valid: false, error: `ยอดสั่งซื้อต้องถึง ฿${promo.minOrderValue} ถึงจะใช้โค้ดนี้ได้ (ยอดตอนนี้ ฿${orderSubtotal})` };
  }
  return { valid: true };
}

// คำนวณส่วนลดจริงจากยอดสินค้า (ไม่รวมค่าส่ง) — ห้ามให้ส่วนลดเกินยอดสินค้า
function calcDiscount(promo, orderSubtotal, shippingPrice) {
  if (promo.type === "percent") {
    return Math.round((orderSubtotal * promo.value) / 100);
  }
  if (promo.type === "free_shipping") {
    // ส่งฟรี = ทำให้ discount เท่ากับค่าส่งพอดี พอไปหักลบในสูตร
    // grandTotal = itemsTotal - discount + shippingPrice แล้วค่าส่งจะกลายเป็น 0 สุทธิ
    return shippingPrice || 0;
  }
  return Math.min(promo.value, orderSubtotal); // fixed
}

// เพิ่มตัวนับ usedCount แบบปลอดภัย (อ่าน-แก้ไข-บันทึกใหม่) ใช้ตอนออร์เดอร์
// ที่ใช้โค้ดนี้ผ่านการตรวจสอบและยืนยันสำเร็จแล้วเท่านั้น
// ถ้าเป็นคูปองส่วนตัว (มี linkedCouponId) จะอัปเดตสถานะ "ใช้ไปแล้ว" กลับไป
// ที่ประวัติคูปองของลูกค้าคนนั้นด้วย (ให้ my-coupons.html แสดงถูกต้อง)
async function finalizePromoUsage(code, orderId) {
  const promotions = await getAllPromotions();
  const idx = promotions.findIndex((p) => p.code === code);
  if (idx === -1) return;

  promotions[idx].usedCount = (promotions[idx].usedCount || 0) + 1;
  await savePromotions(promotions);

  const promo = promotions[idx];
  if (promo.linkedCouponId && promo.restrictedToUserId) {
    try {
      const couponsData = await kv.get(`coupons:${promo.restrictedToUserId}`);
      const coupons = couponsData
        ? (typeof couponsData === "string" ? JSON.parse(couponsData) : couponsData)
        : [];
      const cIdx = coupons.findIndex((c) => c.id === promo.linkedCouponId);
      if (cIdx !== -1) {
        coupons[cIdx].usedAt = new Date().toISOString();
        coupons[cIdx].usedInOrderId = orderId;
        await kv.set(`coupons:${promo.restrictedToUserId}`, JSON.stringify(coupons));
      }
    } catch (e) {
      console.error("sync coupon usage failed:", e);
    }
  }
}

// สร้างโค้ดสั้นๆ ที่ไม่ซ้ำกับที่มีอยู่แล้ว (ใช้ตอนออกคูปองส่วนตัว เช่น
// คูปองวันเกิด) prefix ช่วยให้แยกประเภทได้ง่ายตอนดูรายการ เช่น "BDAY"
async function generateUniquePromoCode(prefix) {
  const promotions = await getAllPromotions();
  const existingCodes = new Set(promotions.map((p) => p.code));
  let code;
  do {
    code = prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (existingCodes.has(code));
  return code;
}

// ═══════════════════════════════════════════════════════════════
// ระบบสะสมแต้ม "พลังงานชีวิต" — ลูกค้าสั่งซื้อสำเร็จ (จ่ายเงินแล้ว) 1 ครั้ง
// = 1 แต้ม สะสมครบ LOYALTY_POINTS_TARGET แต้ม → ได้รับรางวัลส่วนลด 1 ใบ
// ทันที (คล้ายคูปองวันเกิด: ออกเป็นโค้ดเฉพาะตัว ใช้ได้ 1 ครั้ง หมดอายุใน
// LOYALTY_REWARD_VALID_MONTHS เดือน) แล้วแท่งพลังจะรีเซ็ตกลับไปเริ่มนับใหม่
// ที่ 0 ทันที — รางวัลแต่ละใบเป็นเอกเทศ ใช้แทนกันไม่ได้ ต้องแลกทีละใบ
// (ถ้ารางวัลใบไหนหมดอายุโดยไม่ได้ใช้ ก็แค่ใบนั้นหายไปเฉยๆ ไม่กระทบแต้มที่
// กำลังสะสมรอบใหม่อยู่ เพราะเป็นคนละส่วนกันตั้งแต่ต้น)
const LOYALTY_POINTS_TARGET = 5;
const LOYALTY_REWARD_DISCOUNT = 15;
const LOYALTY_REWARD_VALID_MONTHS = 6;

async function addLoyaltyPoint(userId) {
  if (!userId) return null;
  try {
    const raw = await kv.get(`customer:${userId}`);
    if (!raw) return null; // ไม่มีโปรไฟล์ลูกค้า ก็ไม่มีที่เก็บแต้ม ข้ามไป
    const customer = typeof raw === "string" ? JSON.parse(raw) : raw;

    const currentPoints = (customer.loyaltyPoints || 0) + 1;
    let rewardCreated = null;

    if (currentPoints >= LOYALTY_POINTS_TARGET) {
      // ── แท่งพลังงานชีวิตครบแล้ว! ออกรางวัลเป็นโค้ดส่วนลดเฉพาะตัว ──
      const couponId = `cpn-loyalty-${userId}-${Date.now()}`;
      const promoCode = await generateUniquePromoCode("LOYAL");
      const expiresDate = new Date();
      expiresDate.setMonth(expiresDate.getMonth() + LOYALTY_REWARD_VALID_MONTHS);

      const promotions = await getAllPromotions();
      promotions.push({
        code: promoCode,
        type: "fixed",
        value: LOYALTY_REWARD_DISCOUNT,
        startDate: null,
        endDate: expiresDate.toISOString().slice(0, 10),
        minOrderValue: 0,
        maxUses: 1,
        usedCount: 0,
        active: true,
        restrictedToUserId: userId,
        linkedCouponId: couponId,
        createdAt: new Date().toISOString(),
        createdBy: "ระบบอัตโนมัติ (สะสมแต้ม)",
      });
      await savePromotions(promotions);

      const couponsData = await kv.get(`coupons:${userId}`);
      const coupons = couponsData
        ? (typeof couponsData === "string" ? JSON.parse(couponsData) : couponsData)
        : [];
      coupons.push({
        id: couponId,
        userId,
        source: "loyalty", // แยกประเภทจากคูปองวันเกิด ให้หน้าเว็บโชว์ต่างกันได้
        code: promoCode,
        discount: LOYALTY_REWARD_DISCOUNT,
        createdAt: new Date().toISOString(),
        expiresAt: expiresDate.toISOString(),
        usedAt: null,
        usedInOrderId: null,
      });
      await kv.set(`coupons:${userId}`, JSON.stringify(coupons));

      rewardCreated = { code: promoCode, discount: LOYALTY_REWARD_DISCOUNT };
      customer.loyaltyPoints = 0; // รีเซ็ตแท่งพลัง เริ่มสะสมรอบใหม่ทันที
    } else {
      customer.loyaltyPoints = currentPoints;
    }

    await kv.set(`customer:${userId}`, customer);
    return { points: customer.loyaltyPoints, target: LOYALTY_POINTS_TARGET, rewardCreated };
  } catch (e) {
    console.error("addLoyaltyPoint failed:", e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// โค้ดจากการ "เล่นเกม" (เช่น Monly Lucky Game พลิกไพ่สุ่มรางวัล) —
// ตั้งใจแยกเป็นระบบเอกเทศ ไม่ยุ่งเกี่ยวกับแต้มสะสม "พลังงานชีวิต" เลย:
// ทุกครั้งที่เล่นจบ 1 รอบ = ออกโค้ดใหม่ 1 โค้ดทันที ใช้ได้ 1 ครั้ง ไม่นับ
// เป็นแต้มสะสมใดๆ ทั้งสิ้น (การเล่นเกมไม่ทำให้แท่งพลังงานชีวิตขยับเลย และ
// การสั่งซื้อก็ไม่ทำให้ได้โค้ดเกมเพิ่มเช่นกัน — คนละระบบ คนละที่เก็บข้อมูล)
const GAME_CODE_VALID_DAYS = 30;
const VALID_PROMO_TYPES = ["percent", "fixed", "free_shipping"];

async function createGameCode(tier, userId, gameId, providedCode) {
  if (!tier || !VALID_PROMO_TYPES.includes(tier.type)) return { error: "ประเภทรางวัลไม่ถูกต้อง" };
  const value = tier.type === "free_shipping" ? 0 : Number(tier.value);
  if (tier.type !== "free_shipping" && (!value || value <= 0 || (tier.type === "percent" && value > 100))) {
    return { error: "ค่าส่วนลดจากเกมไม่ถูกต้อง" };
  }

  try {
    // รองรับกรณีฝั่งลูกค้าสร้างโค้ดไว้ล่วงหน้าเอง (เพื่อโชว์ผลทันทีไม่ต้องรอเซิร์ฟเวอร์)
    // ต้องตรวจสอบรูปแบบ + ความไม่ซ้ำก่อนเสมอ ไม่เชื่อค่าที่ส่งมาตรงๆ — ถ้าผิดรูปแบบ
    // หรือชนกับโค้ดที่มีอยู่แล้ว จะสร้างโค้ดใหม่ให้แทนอัตโนมัติ (กันโค้ดหลุด/ปลอมแปลง)
    let promoCode;
    const isValidFormat = typeof providedCode === "string" && /^[A-Z0-9-]{4,20}$/.test(providedCode.trim().toUpperCase());
    if (isValidFormat) {
      const promotions = await getAllPromotions();
      const clean = providedCode.trim().toUpperCase();
      const collision = promotions.some((p) => p.code === clean);
      promoCode = collision ? await generateUniquePromoCode("GAME") : clean;
    } else {
      promoCode = await generateUniquePromoCode("GAME");
    }
    const expiresDate = new Date();
    expiresDate.setDate(expiresDate.getDate() + GAME_CODE_VALID_DAYS);
    const couponId = `cpn-game-${userId || "guest"}-${Date.now()}`;

    const promotions = await getAllPromotions();
    promotions.push({
      code: promoCode,
      type: tier.type,
      value,
      startDate: null,
      endDate: expiresDate.toISOString().slice(0, 10),
      minOrderValue: 0,
      maxUses: 1,
      usedCount: 0,
      active: true,
      restrictedToUserId: userId || null, // ไม่มี userId (เช่น เล่นนอกแอป LINE) ก็ยังใช้โค้ดได้ปกติ แค่ไม่ผูกเจ้าของ
      linkedCouponId: userId ? couponId : null,
      linkedGameId: gameId || null,
      createdAt: new Date().toISOString(),
      createdBy: "ระบบอัตโนมัติ (เล่นเกม)",
    });
    await savePromotions(promotions);

    // ถ้ามี userId ให้บันทึกลง "คูปองของฉัน" ด้วย เพื่อให้ลูกค้าเห็นประวัติ/โค้ดย้อนหลังได้
    if (userId) {
      const couponsData = await kv.get(`coupons:${userId}`);
      const coupons = couponsData
        ? (typeof couponsData === "string" ? JSON.parse(couponsData) : couponsData)
        : [];
      coupons.push({
        id: couponId,
        userId,
        source: "game", // แยกประเภทจากคูปองวันเกิดและรางวัลสะสมแต้ม
        code: promoCode,
        rewardType: tier.type,
        discountPercent: tier.type === "percent" ? value : null,
        discountValue: tier.type === "fixed" ? value : null,
        title: tier.title || null,
        gameId: gameId || null,
        createdAt: new Date().toISOString(),
        expiresAt: expiresDate.toISOString(),
        usedAt: null,
        usedInOrderId: null,
      });
      await kv.set(`coupons:${userId}`, JSON.stringify(coupons));
    }

    return { code: promoCode, type: tier.type, value, expiresAt: expiresDate.toISOString() };
  } catch (e) {
    console.error("createGameCode failed:", e);
    return { error: "สร้างโค้ดจากเกมไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// เช็คแบบง่ายว่าโปรโมชั่นนี้ "อยู่ในช่วงใช้งานได้" ตอนนี้ไหม (ไม่เช็คยอดขั้นต่ำ/
// เจ้าของ เพราะใช้แค่ตอน "ค้นหาว่ามีเกม/โปรโมชั่นอะไรโชว์ได้บ้าง" ไม่ใช่ตอน
// ยืนยันใช้จริง — ตอนยืนยันใช้จริงต้องผ่าน checkPromoValidity เต็มรูปแบบเสมอ
function isCurrentlyActive(promo) {
  if (!promo.active) return false;
  const today = getThailandDateString();
  if (promo.startDate && today < promo.startDate) return false;
  if (promo.endDate && today > promo.endDate) return false;
  if (promo.maxUses != null && promo.usedCount >= promo.maxUses) return false;
  return true;
}

// สร้าง gameId แบบสุ่มไม่ซ้ำ (คนละตัวกับโค้ดส่วนลดจริง) ใช้อ้างอิงว่า
// ลูกค้ากำลังเล่น/รับโค้ดของ "เกมไหน" โดยไม่ต้องเปิดเผยโค้ดจริงตั้งแต่แรก
async function generateUniqueGameId() {
  const promotions = await getAllPromotions();
  const existingIds = new Set(promotions.filter((p) => p.gameId).map((p) => p.gameId));
  let id;
  do {
    id = "game_" + Math.random().toString(36).slice(2, 10);
  } while (existingIds.has(id));
  return id;
}

// ดึงรายการ "โปรโมชั่นเกม" ทั้งหมดที่เปิดใช้งานอยู่ตอนนี้ (รองรับหลายเกม
// พร้อมกัน) คืนแค่ข้อมูลที่ปลอดภัยให้ลูกค้าเห็น (ไม่มีโค้ดจริงติดมาด้วย)
async function getActiveGamePromotions() {
  const promotions = await getAllPromotions();
  return promotions
    .filter((p) => p.gameUrl && p.gameId && isCurrentlyActive(p))
    .map((p) => ({ gameId: p.gameId, gameUrl: p.gameUrl, label: p.gameLabel || "เล่นเกมรับโค้ดส่วนลดฟรี!" }));
}

module.exports = {
  getAllPromotions,
  savePromotions,
  checkPromoValidity,
  isCurrentlyActive,
  calcDiscount,
  finalizePromoUsage,
  generateUniquePromoCode,
  generateUniqueGameId,
  getActiveGamePromotions,
  addLoyaltyPoint,
  createGameCode,
  getThailandDateString,
};
