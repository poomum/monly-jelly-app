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

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (วันที่ปัจจุบัน)
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
function calcDiscount(promo, orderSubtotal) {
  if (promo.type === "percent") {
    return Math.round((orderSubtotal * promo.value) / 100);
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

// เช็คแบบง่ายว่าโปรโมชั่นนี้ "อยู่ในช่วงใช้งานได้" ตอนนี้ไหม (ไม่เช็คยอดขั้นต่ำ/
// เจ้าของ เพราะใช้แค่ตอน "ค้นหาว่ามีเกม/โปรโมชั่นอะไรโชว์ได้บ้าง" ไม่ใช่ตอน
// ยืนยันใช้จริง — ตอนยืนยันใช้จริงต้องผ่าน checkPromoValidity เต็มรูปแบบเสมอ
function isCurrentlyActive(promo) {
  if (!promo.active) return false;
  const today = new Date().toISOString().slice(0, 10);
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
};
