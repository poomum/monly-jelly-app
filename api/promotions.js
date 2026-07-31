// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Promotions API (Vercel Serverless Function)
// วางไฟล์นี้ที่: /api/promotions.js
//
//   GET    /api/promotions              → ดูโปรโมชั่นทั้งหมด (แอดมินเท่านั้น)
//   GET    /api/promotions?code=XXX&subtotal=NNN → เช็คโค้ด (ลูกค้าใช้ตอนกรอกโค้ด - ไม่ต้อง login)
//   POST   /api/promotions              → สร้างโปรโมชั่นใหม่ (แอดมิน)
//   PATCH  /api/promotions?code=XXX     → แก้ไข/เปิดปิดโปรโมชั่น (แอดมิน)
//   DELETE /api/promotions?code=XXX     → ลบโปรโมชั่น (แอดมิน)
//
// โครงสร้างข้อมูลโปรโมชั่น:
//   {
//     code: "AUGUST10",             ← รหัสโปรโมชั่น (ตัวพิมพ์ใหญ่เสมอ)
//     type: "percent" | "fixed",    ← ลดเป็น % หรือลดจำนวนเงินคงที่
//     value: 10,                   ← ค่าที่ลด (10 = ลด 10% หรือ 10 บาท)
//     startDate: "2026-08-01",      ← วันเริ่มใช้ได้ (YYYY-MM-DD)
//     endDate: "2026-08-31",        ← วันหมดอายุ (YYYY-MM-DD, รวมวันนี้ด้วย)
//     minOrderValue: 0,             ← ยอดขั้นต่ำที่ใช้โค้ดได้ (0 = ไม่จำกัด)
//     maxUses: null,                ← จำนวนครั้งที่ใช้ได้ทั้งหมด (null = ไม่จำกัด)
//     usedCount: 0,                 ← ใช้ไปแล้วกี่ครั้ง (ระบบนับให้เอง)
//     active: true,                 ← เปิด/ปิดใช้งาน
//     createdAt, createdBy
//   }
// ═══════════════════════════════════════════════════════════════

const { validateSession, logAdminAction } = require("../lib/adminAuth");
const { getAllPromotions, savePromotions, checkPromoValidity, isCurrentlyActive, calcDiscount, generateUniqueGameId, getActiveGamePromotions } = require("../lib/promotions");

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { code } = req.query;

  // ── GET ?activePromos=true → ดูรายการโปรโมชั่นทั่วไปที่ใช้งานได้ตอนนี้ ──
  // (ใช้แสดงเป็น popup โฆษณาในหน้าแรก ไม่ต้อง login) ไม่รวมโปรโมชั่นเกม
  // (มี popup ของตัวเองแยกต่างหาก) และไม่รวมคูปองส่วนตัว/วันเกิด (เป็น
  // ความลับเฉพาะเจ้าของคนนั้น ไม่ควรโฆษณาให้คนอื่นเห็น)
  if (req.method === "GET" && req.query.activePromos === "true") {
    const promotions = await getAllPromotions();
    const activePromos = promotions
      .filter((p) => !p.gameUrl && !p.restrictedToUserId && isCurrentlyActive(p))
      .map((p) => ({
        code: p.code,
        type: p.type,
        value: p.value,
        minOrderValue: p.minOrderValue || 0,
        endDate: p.endDate,
        popupImageUrl: p.popupImageUrl || null,
        popupVideoUrl: p.popupVideoUrl || null,
        popupQrData: p.popupQrData || null,
        popupText: p.popupText || null,
      }));
    res.status(200).json({ hasPromos: activePromos.length > 0, promos: activePromos });
    return;
  }

  // ── GET ?activeGames=true → ดูรายการ "โปรโมชั่นเกม" ทั้งหมดที่เปิดอยู่ ──
  // (รองรับหลายเกมพร้อมกัน) ลูกค้าใช้ตอนโหลดหน้าจอง ไม่ต้อง login
  // *** ไม่ส่งโค้ดจริงกลับไปตอนนี้ *** ต้องกด "เล่นแล้ว" ก่อนถึงจะได้โค้ด
  if (req.method === "GET" && req.query.activeGames === "true") {
    const games = await getActiveGamePromotions();
    res.status(200).json({ hasGames: games.length > 0, games });
    return;
  }

  // ── GET ?revealGameCode=true&gameId=XXX → เปิดเผยโค้ดของเกมนั้นๆ ──
  // (หลังลูกค้ากด "เล่นแล้ว" สำหรับเกมที่ระบุ)
  if (req.method === "GET" && req.query.revealGameCode === "true") {
    const { gameId } = req.query;
    if (!gameId) { res.status(400).json({ error: "ต้องระบุ ?gameId=" }); return; }
    const promotions = await getAllPromotions();
    const gamePromo = promotions.find((p) => p.gameId === gameId && p.gameUrl && isCurrentlyActive(p));
    if (!gamePromo) {
      res.status(404).json({ error: "ไม่พบโปรโมชั่นเกมนี้ หรือหมดอายุ/ปิดใช้งานไปแล้ว" });
      return;
    }
    res.status(200).json({ code: gamePromo.code });
    return;
  }

  // ── GET ?code=XXX → เช็คโค้ด (ลูกค้าใช้ตอนกรอกโค้ด ไม่ต้อง login) ──
  if (req.method === "GET" && code) {
    const promotions = await getAllPromotions();
    const promo = promotions.find((p) => p.code === String(code).toUpperCase().trim());
    const subtotal = Number(req.query.subtotal) || 0;
    const requestingUserId = req.query.userId || null;
    const result = checkPromoValidity(promo, subtotal, requestingUserId);

    if (!result.valid) {
      res.status(200).json({ valid: false, error: result.error });
      return;
    }

    const discount = calcDiscount(promo, subtotal);
    res.status(200).json({
      valid: true,
      code: promo.code,
      type: promo.type,
      value: promo.value,
      discount,
    });
    return;
  }

  // ── GET (ไม่มี ?code=) → ดูโปรโมชั่นทั้งหมด (แอดมินเท่านั้น) ──
  if (req.method === "GET") {
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }
    logAdminAction(session.name, "ดูรายการโปรโมชั่นทั้งหมด");
    let promotions = await getAllPromotions();
    // ซ่อนคูปองส่วนตัว (เช่น คูปองวันเกิดที่ระบบสร้างให้เอง) ออกจากรายการ
    // เริ่มต้น กันหน้าจัดการโปรโมชั่นทั่วไปรกด้วยคูปองต่อลูกค้าเป็นร้อยๆ ใบ
    // ใส่ ?includePersonal=true ถ้าอยากดูทั้งหมดจริงๆ
    if (req.query.includePersonal !== "true") {
      promotions = promotions.filter((p) => !p.restrictedToUserId);
    }
    res.status(200).json({ total: promotions.length, promotions });
    return;
  }

  // ── POST → สร้างโปรโมชั่นใหม่ (แอดมิน) ──
  if (req.method === "POST") {
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }

    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const { code: newCode, type, value, startDate, endDate, minOrderValue, maxUses, gameUrl, gameLabel, popupImageUrl, popupVideoUrl, popupQrData, popupText } = body;

    if (!newCode || !String(newCode).trim()) {
      res.status(400).json({ error: "กรุณาระบุรหัสโปรโมชั่น" }); return;
    }
    if (type !== "percent" && type !== "fixed") {
      res.status(400).json({ error: "type ต้องเป็น 'percent' หรือ 'fixed' เท่านั้น" }); return;
    }
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue <= 0) {
      res.status(400).json({ error: "value ต้องเป็นตัวเลขมากกว่า 0" }); return;
    }
    if (type === "percent" && numValue > 100) {
      res.status(400).json({ error: "ลดเป็น % ต้องไม่เกิน 100" }); return;
    }
    // ถ้าใส่ลิงก์เกมมา ต้องเป็น URL ที่ขึ้นต้นด้วย http:// หรือ https:// เท่านั้น
    // (กันใส่ค่าประหลาดที่อาจกลายเป็นช่องโหว่ตอนแสดงผลเป็นลิงก์ให้ลูกค้ากด)
    if (gameUrl && String(gameUrl).trim() && !/^https?:\/\//i.test(String(gameUrl).trim())) {
      res.status(400).json({ error: "ลิงก์เกมต้องขึ้นต้นด้วย http:// หรือ https:// เท่านั้น" }); return;
    }
    // ถ้าใส่ลิงก์รูป popup มา ต้องเป็น URL ที่ขึ้นต้นด้วย http:// หรือ https:// เช่นกัน
    if (popupImageUrl && String(popupImageUrl).trim() && !/^https?:\/\//i.test(String(popupImageUrl).trim())) {
      res.status(400).json({ error: "ลิงก์รูป popup ต้องขึ้นต้นด้วย http:// หรือ https:// เท่านั้น" }); return;
    }
    // ถ้าใส่ลิงก์วิดีโอ popup มา ต้องเป็น URL ที่ขึ้นต้นด้วย http:// หรือ https:// เช่นกัน
    // (แนะนำให้ใช้ไฟล์ .mp4 โดยตรง เพื่อความเสถียรสูงสุดบน LINE in-app browser และแพลตฟอร์มอื่นๆ)
    if (popupVideoUrl && String(popupVideoUrl).trim() && !/^https?:\/\//i.test(String(popupVideoUrl).trim())) {
      res.status(400).json({ error: "ลิงก์วิดีโอ popup ต้องขึ้นต้นด้วย http:// หรือ https:// เท่านั้น" }); return;
    }
    // popupQrData เป็นข้อความ/ลิงก์อะไรก็ได้ที่จะเอาไปสร้างเป็น QR ให้ลูกค้าสแกน
    // จำกัดความยาวไว้กันข้อความยาวเกินไปจนสแกนไม่ติด (QR ยิ่งข้อมูลเยอะยิ่งละเอียด/สแกนยาก)
    if (popupQrData && String(popupQrData).trim().length > 300) {
      res.status(400).json({ error: "ข้อมูลสำหรับสร้าง QR ยาวเกินไป (ไม่เกิน 300 ตัวอักษร ไม่งั้นสแกนยาก)" }); return;
    }

    const codeUpper = String(newCode).toUpperCase().trim();
    const promotions = await getAllPromotions();

    if (promotions.some((p) => p.code === codeUpper)) {
      res.status(409).json({ error: `โค้ด "${codeUpper}" มีอยู่แล้วในระบบ กรุณาใช้ชื่ออื่น` });
      return;
    }

    const cleanGameUrl = gameUrl && String(gameUrl).trim() ? String(gameUrl).trim() : null;
    const gameId = cleanGameUrl ? await generateUniqueGameId() : null;

    const newPromo = {
      code: codeUpper,
      type,
      value: numValue,
      startDate: startDate || null,
      endDate: endDate || null,
      minOrderValue: Number(minOrderValue) || 0,
      maxUses: maxUses ? Number(maxUses) : null,
      usedCount: 0,
      active: true,
      gameUrl: cleanGameUrl,
      gameId,
      gameLabel: gameLabel && String(gameLabel).trim() ? String(gameLabel).trim() : null,
      popupImageUrl: popupImageUrl && String(popupImageUrl).trim() ? String(popupImageUrl).trim() : null,
      popupVideoUrl: popupVideoUrl && String(popupVideoUrl).trim() ? String(popupVideoUrl).trim() : null,
      popupQrData: popupQrData && String(popupQrData).trim() ? String(popupQrData).trim() : null,
      popupText: popupText && String(popupText).trim() ? String(popupText).trim() : null,
      createdAt: new Date().toISOString(),
      createdBy: session.name,
    };

    promotions.push(newPromo);
    await savePromotions(promotions);
    logAdminAction(session.name, `สร้างโปรโมชั่นใหม่ "${codeUpper}"`, newPromo);

    res.status(201).json({ ok: true, promotion: newPromo });
    return;
  }

  // ── PATCH ?code=XXX → แก้ไข/เปิดปิดโปรโมชั่น (แอดมิน) ──
  if (req.method === "PATCH") {
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }
    if (!code) { res.status(400).json({ error: "ต้องระบุ ?code=" }); return; }

    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const promotions = await getAllPromotions();
    const idx = promotions.findIndex((p) => p.code === String(code).toUpperCase().trim());
    if (idx === -1) { res.status(404).json({ error: "ไม่พบโค้ดนี้" }); return; }

    if (body.gameUrl && String(body.gameUrl).trim() && !/^https?:\/\//i.test(String(body.gameUrl).trim())) {
      res.status(400).json({ error: "ลิงก์เกมต้องขึ้นต้นด้วย http:// หรือ https:// เท่านั้น" }); return;
    }
    if (body.popupImageUrl && String(body.popupImageUrl).trim() && !/^https?:\/\//i.test(String(body.popupImageUrl).trim())) {
      res.status(400).json({ error: "ลิงก์รูป popup ต้องขึ้นต้นด้วย http:// หรือ https:// เท่านั้น" }); return;
    }
    if (body.popupVideoUrl && String(body.popupVideoUrl).trim() && !/^https?:\/\//i.test(String(body.popupVideoUrl).trim())) {
      res.status(400).json({ error: "ลิงก์วิดีโอ popup ต้องขึ้นต้นด้วย http:// หรือ https:// เท่านั้น" }); return;
    }
    if (body.popupQrData && String(body.popupQrData).trim().length > 300) {
      res.status(400).json({ error: "ข้อมูลสำหรับสร้าง QR ยาวเกินไป (ไม่เกิน 300 ตัวอักษร ไม่งั้นสแกนยาก)" }); return;
    }

    const allowedFields = ["type", "value", "startDate", "endDate", "minOrderValue", "maxUses", "active", "gameUrl", "gameLabel", "popupImageUrl", "popupVideoUrl", "popupQrData", "popupText"];
    for (const field of allowedFields) {
      if (body[field] !== undefined) promotions[idx][field] = body[field];
    }

    // ถ้าเพิ่งใส่ลิงก์เกมเข้ามาใหม่ (ไม่เคยมี gameId มาก่อน) ให้สร้างให้อัตโนมัติ
    if (promotions[idx].gameUrl && !promotions[idx].gameId) {
      promotions[idx].gameId = await generateUniqueGameId();
    }
    // ถ้าลบลิงก์เกมออก (ตั้งเป็นค่าว่าง) ให้ล้าง gameId ทิ้งด้วย
    if (!promotions[idx].gameUrl) {
      promotions[idx].gameId = null;
    }

    await savePromotions(promotions);
    logAdminAction(session.name, `แก้ไขโปรโมชั่น "${promotions[idx].code}"`, body);

    res.status(200).json({ ok: true, promotion: promotions[idx] });
    return;
  }

  // ── DELETE ?code=XXX → ลบโปรโมชั่น (แอดมิน) ──
  if (req.method === "DELETE") {
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }
    if (!code) { res.status(400).json({ error: "ต้องระบุ ?code=" }); return; }

    let promotions = await getAllPromotions();
    const before = promotions.length;
    promotions = promotions.filter((p) => p.code !== String(code).toUpperCase().trim());

    if (promotions.length === before) { res.status(404).json({ error: "ไม่พบโค้ดนี้" }); return; }

    await savePromotions(promotions);
    logAdminAction(session.name, `ลบโปรโมชั่น "${String(code).toUpperCase()}"`);

    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
};
