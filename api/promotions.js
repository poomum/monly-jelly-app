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
const { getAllPromotions, savePromotions, checkPromoValidity, isCurrentlyActive, calcDiscount, generateUniqueGameId, getActiveGamePromotions, createGameCode, getThailandDateString } = require("../lib/promotions");

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

// ── ตรวจสอบ+ทำความสะอาดชุดรางวัลที่แอดมินกำหนดเองสำหรับเกม ──
// (คืนค่า null ถ้าไม่ได้ส่งมา หรือ throw string error message ถ้าข้อมูลผิดรูปแบบ)
const VALID_TIER_TYPES = ["percent", "fixed", "free_shipping"];
const MAX_TIERS = 10;

// ชุดรางวัลเริ่มต้น ใช้เมื่อแอดมินไม่ได้กำหนดรางวัลเองไว้สำหรับเกมนั้นๆ
// (ต้องตรงกับ rewards array เริ่มต้นใน monly-lucky-game.html เสมอ)
const DEFAULT_GAME_TIERS = [
  { type: "percent", value: 5, title: "Little Smile", emoji: "🍋", weight: 40, messageTH: "วันนี้โลกอาจวุ่นวาย...แต่คุณยังน่ารักเหมือนเดิม 😊", messageEN: "The world may be busy today... but you're still adorable." },
  { type: "percent", value: 8, title: "Good Vibes", emoji: "💚", weight: 30, messageTH: "ไม่ต้องเก่งทุกวันก็ได้ แค่มีความสุขก็พอ 🌼", messageEN: "You don't have to be perfect every day. Just be happy." },
  { type: "percent", value: 10, title: "Lucky Day", emoji: "💜", weight: 15, messageTH: "วันนี้โชคกำลังเดินมาหาคุณ 🍀", messageEN: "Luck is finding its way to you today." },
  { type: "free_shipping", value: 0, title: "Sweet Delivery", emoji: "🚚", weight: 10, messageTH: "วันนี้ไม่ต้องเสียค่าส่ง เก็บเงินไว้ซื้อเยลลี่เพิ่มดีกว่า 💕", messageEN: "No shipping fee today — save it for more jelly instead!" },
  { type: "percent", value: 15, title: "JACKPOT", emoji: "👑", weight: 5, messageTH: "จักรวาลประชุมกันแล้ว...สรุปว่าคุณควรได้รางวัลนี้! 🌈", messageEN: "The universe had a meeting... and decided you deserve this reward!" },
];

function validateGameRewardTiers(tiers) {
  if (tiers === undefined || tiers === null) return { tiers: null };
  if (!Array.isArray(tiers)) return { error: "gameRewardTiers ต้องเป็น array" };
  if (tiers.length > MAX_TIERS) return { error: `ตั้งรางวัลได้ไม่เกิน ${MAX_TIERS} แบบ` };

  const cleaned = [];
  for (const t of tiers) {
    if (!t || typeof t !== "object") return { error: "รูปแบบรางวัลไม่ถูกต้อง" };
    if (!VALID_TIER_TYPES.includes(t.type)) return { error: "ประเภทรางวัลต้องเป็น percent, fixed หรือ free_shipping" };
    if (!t.title || !String(t.title).trim()) return { error: "กรุณาตั้งชื่อรางวัลให้ครบทุกแบบ" };

    const value = t.type === "free_shipping" ? 0 : Number(t.value);
    if (t.type !== "free_shipping" && (!Number.isFinite(value) || value <= 0)) {
      return { error: `ค่าที่ลดของรางวัล "${t.title}" ต้องเป็นตัวเลขมากกว่า 0` };
    }
    if (t.type === "percent" && value > 100) {
      return { error: `ส่วนลด % ของรางวัล "${t.title}" ต้องไม่เกิน 100` };
    }

    // น้ำหนักการสุ่ม (weight) — ยิ่งมากยิ่งออกบ่อย ไม่ใส่มา = ถือว่าน้ำหนักเท่ากันหมด (ค่าเริ่มต้น 1)
    let weight = 1;
    if (t.weight !== undefined && t.weight !== null && t.weight !== "") {
      weight = Number(t.weight);
      if (!Number.isFinite(weight) || weight <= 0) {
        return { error: `น้ำหนักของรางวัล "${t.title}" ต้องเป็นตัวเลขมากกว่า 0` };
      }
    }

    cleaned.push({
      type: t.type,
      value,
      title: String(t.title).trim().slice(0, 50),
      emoji: t.emoji ? String(t.emoji).trim().slice(0, 10) : "🎁",
      weight,
      messageTH: t.messageTH ? String(t.messageTH).trim().slice(0, 200) : "",
      messageEN: t.messageEN ? String(t.messageEN).trim().slice(0, 200) : "",
    });
  }
  return { tiers: cleaned.length > 0 ? cleaned : null };
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
    // สำคัญ: เรียงตามวันที่สร้างจริง (createdAt) จากใหม่ไปเก่าอย่างชัดเจน แทน
    // การพึ่งพาลำดับใน array เฉยๆ (ซึ่งอาจไม่แน่นอนขึ้นอยู่กับว่าข้อมูลถูกอ่าน/
    // เขียนทับกี่รอบมาก่อน) — ถ้าไม่มี createdAt เลย (โปรเก่ามากๆ ก่อนจะมี
    // ฟิลด์นี้) ให้ถือว่าเก่าที่สุด จะได้จมไปอยู่ท้ายแถวเสมอ ไม่มาบังโปรใหม่
    const sorted = promotions.slice().sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA; // ใหม่ไปเก่า (descending)
    });
    const activePromos = sorted
      .filter((p) => {
        if (p.restrictedToUserId || !isCurrentlyActive(p)) return false;
        // สำคัญมาก: ต้องกันโค้ดรางวัลที่เกิดจากการเล่นเกม (linkedGameId ตั้งไว้)
        // ออกไปก่อนเสมอ — โค้ดพวกนี้สร้างขึ้นมาให้ผู้เล่นแต่ละคนใช้เอง ไม่มี
        // gameUrl/restrictedToUserId ติดมาด้วย (ตั้งใจให้ใครก็ใช้โค้ดได้ ไม่ผูก
        // คนเดียว) ทำให้เข้าเงื่อนไข "โปรทั่วไป" ผิดๆ ได้ถ้าไม่กันไว้ตรงนี้ — พอ
        // มีคนเล่นเกมเมื่อไหร่ โค้ดใหม่ที่เพิ่งสร้างจะแซงหน้าโปรที่ผูกเกมจริงๆ
        // (ซึ่งมีรูป/QR ตั้งไว้) ไปแสดงแทนทันที ทำให้ popup ที่ควรโชว์รูปเกม
        // กลับไม่มีรูปอะไรเลย (บั๊กที่เจอจริง)
        if (p.linkedGameId) return false;
        // โปรทั่วไป (ไม่ผูกเกม) โชว์ได้เสมอถ้ายัง active อยู่
        if (!p.gameUrl) return true;
        // โปรที่ผูกเกมไว้ จะโชว์ popup ด้วยก็ต่อเมื่อแอดมินตั้งเนื้อหา popup ไว้จริงๆ
        // เท่านั้น (รูป/วิดีโอ/QR/ข้อความ) ไม่งั้นจะไปโชว์แค่แบนเนอร์ตอนเช็คเอาท์เหมือนเดิม
        return !!(p.popupImageUrl || p.popupVideoUrl || p.popupQrData || p.popupText);
      })
      .map((p) => {
        // ถ้าผูกเกมไว้แต่ไม่ได้ตั้ง QR เองไว้ ให้สร้าง QR จากลิงก์เกมให้อัตโนมัติเลย
        // (ลูกค้าสแกนแล้วไปเล่นเกมได้ทันที ไม่ต้องให้แอดมินไปก็อบลิงก์มาใส่เอง)
        let popupQrData = p.popupQrData || null;
        if (p.gameUrl && !popupQrData) {
          const sep = p.gameUrl.includes("?") ? "&" : "?";
          popupQrData = p.gameUrl + sep + "mjGameId=" + encodeURIComponent(p.gameId || "");
        }
        return {
          code: p.code,
          type: p.type,
          value: p.value,
          minOrderValue: p.minOrderValue || 0,
          endDate: p.endDate,
          isGamePromo: !!p.gameUrl, // บอกฝั่งลูกค้าว่านี่คือโปรผูกเกม ต้องซ่อนโค้ดจริง ไม่งั้นข้ามเล่นเกมได้เลย
          popupImageUrl: p.popupImageUrl || null,
          popupVideoUrl: p.popupVideoUrl || null,
          popupQrData,
          popupText: p.popupText || null,
        };
      });
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

  // ── GET ?gameRewardTiers=true&gameId=XXX → ดึงชุดรางวัลที่แอดมินตั้งไว้
  //    สำหรับเกมนี้ (ให้หน้าเกม เช่น Monly Lucky Game ดึงไปสุ่มแสดงผล)
  //    ถ้าแอดมินไม่ได้ตั้งชุดรางวัลเองไว้ จะได้ tiers: null กลับไป (หน้าเกม
  //    จะใช้ชุดรางวัลเริ่มต้นของตัวเองแทน) ──
  if (req.method === "GET" && req.query.gameRewardTiers === "true") {
    const { gameId } = req.query;
    if (!gameId) { res.status(400).json({ error: "ต้องระบุ ?gameId=" }); return; }
    const promotions = await getAllPromotions();
    const gamePromo = promotions.find((p) => p.gameId === gameId && p.gameUrl);
    if (!gamePromo) {
      res.status(404).json({ error: "ไม่พบเกมนี้ในระบบ" });
      return;
    }
    res.status(200).json({ tiers: gamePromo.gameRewardTiers || null });
    return;
  }

  // ── POST ?generateGameCode=true → ทุกครั้งที่เล่นเกมจบ 1 รอบ (เช่น Monly
  //    Lucky Game พลิกไพ่) ออกโค้ดส่วนลดใหม่ให้ทันที แยกเอกเทศจากระบบแต้ม
  //    สะสม "พลังงานชีวิต" โดยสิ้นเชิง — ไม่ต้อง login เพราะลูกค้าเรียกเอง
  //    ตอนเล่นเกมจบ (เป็น endpoint สาธารณะเหมือน revealGameCode ด้านบน)
  //    รับ tierIndex (ตำแหน่งในชุดรางวัลของเกมนั้น) แทนค่าส่วนลดดิบๆ เสมอ —
  //    เซิร์ฟเวอร์เป็นคนตัดสินใจเองว่าค่าจริงคือเท่าไหร่ จากชุดรางวัลที่แอดมิน
  //    ตั้งไว้ (หรือชุดเริ่มต้นถ้าไม่ได้ตั้ง) ไม่เชื่อค่าที่ฝั่งลูกค้าส่งมาตรงๆ ──
  if (req.method === "POST" && req.query.generateGameCode === "true") {
    let body = {};
    try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
    catch { res.status(400).json({ error: "invalid json" }); return; }

    const { gameId, tierIndex, userId, code: clientCode } = body;
    if (!gameId) { res.status(400).json({ error: "ต้องระบุ gameId" }); return; }
    if (tierIndex === undefined || tierIndex === null) { res.status(400).json({ error: "ต้องระบุ tierIndex" }); return; }

    const promotions = await getAllPromotions();
    // เช็ค "มีเกมนี้อยู่จริงไหม" แยกจาก "ยังใช้งานได้อยู่ไหม" ก่อน เพื่อให้ error
    // message ชัดเจนขึ้น (ไม่งั้นเกมที่แจกโค้ดครบโควต้าแล้วจะโดนนับปนกับ
    // "ไม่พบเกมนี้เลย" เพราะ isCurrentlyActive เช็ค usedCount>=maxUses ด้วยอยู่แล้ว)
    const gIdxRaw = promotions.findIndex((p) => p.gameId === gameId && p.gameUrl);
    if (gIdxRaw === -1) {
      res.status(404).json({ error: "ไม่พบเกมนี้ในระบบ" });
      return;
    }
    const gIdx = gIdxRaw;
    const gamePromo = promotions[gIdx];

    // ── กันลูกค้าคนเดิมเล่นซ้ำเพื่อเอาโค้ดหลายใบ (เช่น ใช้ ?reset=true ล้างค่า
    //    "เล่นไปแล้ว" ในเบราว์เซอร์ตัวเอง แล้วเล่นใหม่) — เช็คฝั่งเซิร์ฟเวอร์เลยว่า
    //    userId คนนี้เคยได้โค้ดจากเกมนี้ไปแล้วหรือยัง ไม่พึ่งแค่ localStorage
    //    ฝั่งเครื่องลูกค้าอย่างเดียว (แก้ไข/ล้างเองได้ ไม่น่าเชื่อถือพอ)
    //    หมายเหตุ: เช็คได้เฉพาะตอนมี userId (login LINE อยู่) เท่านั้น — ถ้าเป็น
    //    guest ที่ไม่มี userId ระบบไม่มีทางรู้ว่าเป็นคนเดิมไหม จึงเช็คไม่ได้ในเคสนี้
    //
    //    เล่นได้ "วันละ 1 ครั้งต่อคนต่อเกม" — เช็คแค่ว่ามีโค้ดที่เคยได้จากเกมนี้
    //    ที่สร้างขึ้น "วันนี้" (ตามเวลา UTC) อยู่แล้วหรือยัง ถ้ายังไม่เคยเล่นวันนี้
    //    (แม้เคยเล่นเมื่อวานหรือก่อนหน้านั้น) ก็เล่นได้ตามปกติ พอข้ามวันใหม่จะเล่น
    //    ได้อีกครั้งเองอัตโนมัติ ไม่ต้องรีเซ็ตอะไรเอง
    if (userId) {
      const todayDate = getThailandDateString();
      const alreadyClaimedToday = promotions.some((p) =>
        p.linkedGameId === gameId &&
        p.playedByUserId === userId &&
        p.createdAt && getThailandDateString(p.createdAt) === todayDate
      );
      if (alreadyClaimedToday) {
        res.status(409).json({ error: "คุณเล่นเกมนี้ไปแล้ววันนี้นะคะ พรุ่งนี้กลับมาเล่นใหม่ได้เลยค่ะ" });
        return;
      }
    }

    // ใช้ maxUses ของเกมเป็น "งบรวม" จำนวนโค้ดที่เกมนี้ออกให้ได้ทั้งหมด (กันเล่นสแปมไม่จำกัด)
    if (gamePromo.maxUses != null && (gamePromo.usedCount || 0) >= gamePromo.maxUses) {
      res.status(409).json({ error: "เกมนี้แจกโค้ดครบจำนวนที่กำหนดไว้แล้วค่ะ" });
      return;
    }
    if (!isCurrentlyActive(gamePromo)) {
      console.warn(
        `[game inactive rejected] gameId=${gameId} code=${gamePromo.code} ` +
        `active=${gamePromo.active} startDate=${gamePromo.startDate || "-"} ` +
        `endDate=${gamePromo.endDate || "-"} today=${getThailandDateString()} ` +
        `maxUses=${gamePromo.maxUses ?? "-"} usedCount=${gamePromo.usedCount || 0}`
      );
      res.status(404).json({ error: "เกมนี้หมดอายุ หรือปิดใช้งานไปแล้ว" });
      return;
    }

    // ใช้ชุดรางวัลที่แอดมินตั้งไว้เอง ถ้าไม่ได้ตั้ง ใช้ชุดเริ่มต้น (5/10/15/20/30%)
    // ให้ตรงกับที่หน้าเกม Monly Lucky Game ใช้เป็นค่า default อยู่แล้ว
    const effectiveTiers = gamePromo.gameRewardTiers && gamePromo.gameRewardTiers.length
      ? gamePromo.gameRewardTiers
      : DEFAULT_GAME_TIERS;
    const idx = Number(tierIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= effectiveTiers.length) {
      res.status(400).json({ error: "tierIndex ไม่ถูกต้อง" });
      return;
    }
    const tier = effectiveTiers[idx];

    // สำคัญ: ต้องอัปเดต usedCount (นับโควต้าที่แจกไปแล้ว) และบันทึก "ก่อน"
    // เรียก createGameCode() เสมอ เพราะ createGameCode ข้างในจะ getAllPromotions()
    // แล้ว savePromotions() ใหม่ของมันเองอีกรอบ (เพื่อเพิ่ม entry โค้ดใหม่) — ถ้า
    // สลับลำดับ การบันทึกรอบหลังจะใช้ snapshot เก่าทับ แล้วโค้ดที่เพิ่งสร้างจะหาย
    promotions[gIdx].usedCount = (promotions[gIdx].usedCount || 0) + 1;
    await savePromotions(promotions);

    const result = await createGameCode(tier, userId || null, gameId, clientCode);
    if (result.error) { res.status(500).json(result); return; }

    res.status(201).json({ ok: true, code: result.code, type: result.type, value: result.value, expiresAt: result.expiresAt });
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

    const discount = calcDiscount(promo, subtotal, Number(req.query.shippingPrice) || 0);
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
    // ซ่อนคูปองส่วนตัว (เช่น คูปองวันเกิดที่ระบบสร้างให้เอง) และโค้ดที่เกมออกให้
    // อัตโนมัติ ออกจากรายการเริ่มต้น กันหน้าจัดการโปรโมชั่นทั่วไปรกด้วยคูปอง/โค้ด
    // ต่อลูกค้าเป็นร้อยๆ ใบ (โค้ดจากเกมเช็คด้วย linkedGameId แทน restrictedToUserId
    // เพราะตอนนี้โค้ดจากเกมไม่ผูกเจ้าของแล้ว restrictedToUserId เลยเป็น null เสมอ)
    // ใส่ ?includePersonal=true ถ้าอยากดูทั้งหมดจริงๆ
    if (req.query.includePersonal !== "true") {
      promotions = promotions.filter((p) => !p.restrictedToUserId && !p.linkedGameId);
    }
    res.status(200).json({ total: promotions.length, promotions });
    return;
  }

  // ── ลบโปรโมชั่นหลายรายการพร้อมกัน (ลบทั้งหมด) ──
  // สำคัญ: ทำเป็นการอ่าน-แก้-บันทึกครั้งเดียว (atomic) แทนที่จะให้ฝั่งหน้าเว็บ
  // วนเรียก DELETE ทีละโค้ด เพราะถ้าเรียกพร้อมกันหลายครั้ง แต่ละครั้งจะอ่าน
  // array เดิมคนละช่วงเวลา แล้วเขียนทับกันเอง ทำให้บางรายการที่ควรถูกลบกลับ
  // รอดไปได้ (race condition) — ทำทีเดียวจบตรงนี้ปลอดภัยกว่ามาก
  // สำคัญมาก: ต้องเช็ค query param เฉพาะนี้ "ก่อน" เช็ค req.method === "POST"
  // แบบทั่วไปด้านล่าง ไม่งั้น request นี้จะโดนจับไปประมวลผลเป็น "สร้างโปรโมชั่น
  // ใหม่" ผิดๆ ก่อน แล้วไม่มีทางมาถึงโค้ดตรงนี้เลย (เคยเป็นบั๊กจริงมาก่อน)
  if (req.method === "POST" && req.query.bulkDelete === "true") {
    const session = await validateSession(req.headers["x-admin-session"]);
    if (!session) {
      res.status(401).json({ error: "unauthorized กรุณา Login ก่อนที่ /api/admin-auth?action=login" });
      return;
    }

    let payload = {};
    try {
      const raw = await getRawBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      res.status(400).json({ error: "invalid json body" });
      return;
    }

    const codesToDelete = Array.isArray(payload.codes) ? payload.codes.map((c) => String(c).toUpperCase().trim()) : [];
    if (!codesToDelete.length) {
      res.status(400).json({ error: "ต้องระบุ codes เป็น array ของโค้ดที่จะลบ" });
      return;
    }

    let promotions = await getAllPromotions();
    const before = promotions.length;
    const codesSet = new Set(codesToDelete);
    promotions = promotions.filter((p) => !codesSet.has(p.code));
    const deletedCount = before - promotions.length;

    await savePromotions(promotions);
    logAdminAction(session.name, `ลบโปรโมชั่นหลายรายการพร้อมกัน (${deletedCount} รายการ)`);

    res.status(200).json({ ok: true, deletedCount });
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

    const { code: newCode, type, value, startDate, endDate, minOrderValue, maxUses, gameUrl, gameLabel, popupImageUrl, popupVideoUrl, popupQrData, popupText, gameRewardTiers } = body;

    if (!newCode || !String(newCode).trim()) {
      res.status(400).json({ error: "กรุณาระบุรหัสโปรโมชั่น" }); return;
    }
    // สำคัญ: ถ้าผูกกับเกมไว้ (มี gameUrl) ไม่ต้องบังคับกรอก type/value เลย
    // เพราะส่วนลดจริงที่ลูกค้าจะได้รับมาจาก gameRewardTiers ทั้งหมด ไม่ได้ใช้
    // ค่า type/value ตรงนี้เลยแม้แต่นิดเดียว — บังคับกรอกไปก็ไม่มีความหมาย
    // อะไรเลย มีแต่จะทำให้แอดมินสับสนว่าทำไมต้องกรอกอะไรที่ไม่ได้ใช้จริง
    const isGameLinked = gameUrl && String(gameUrl).trim();
    if (!isGameLinked) {
      if (type !== "percent" && type !== "fixed" && type !== "free_shipping") {
        res.status(400).json({ error: "type ต้องเป็น 'percent', 'fixed' หรือ 'free_shipping' เท่านั้น" }); return;
      }
    }
    // free_shipping ไม่ต้องใช้ value (ส่งฟรีคือส่งฟรี ไม่มีตัวเลขให้กรอก) ส่วน percent/fixed ต้องมี value > 0
    const numValue = type === "free_shipping" ? 0 : Number(value);
    if (!isGameLinked && type !== "free_shipping" && (!Number.isFinite(numValue) || numValue <= 0)) {
      res.status(400).json({ error: "value ต้องเป็นตัวเลขมากกว่า 0" }); return;
    }
    if (!isGameLinked && type === "percent" && numValue > 100) {
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
    const tiersResult = validateGameRewardTiers(gameRewardTiers);
    if (tiersResult.error) { res.status(400).json({ error: tiersResult.error }); return; }

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
      type: type || "fixed", // ค่า default เผื่อผูกเกมแล้วไม่ได้กรอก (ไม่ได้ใช้จริงถ้ามี gameRewardTiers)
      value: numValue || 0,
      startDate: startDate || null,
      endDate: endDate || null,
      minOrderValue: isGameLinked ? 0 : (Number(minOrderValue) || 0),
      maxUses: maxUses ? Number(maxUses) : null,
      usedCount: 0,
      active: true,
      gameUrl: cleanGameUrl,
      gameId,
      gameLabel: gameLabel && String(gameLabel).trim() ? String(gameLabel).trim() : null,
      popupImageUrl: popupImageUrl && String(popupImageUrl).trim() ? String(popupImageUrl).trim() : null,
      popupVideoUrl: popupVideoUrl && String(popupVideoUrl).trim() ? String(popupVideoUrl).trim() : null,
      popupQrData: popupQrData && String(popupQrData).trim() ? String(popupQrData).trim() : null,
      gameRewardTiers: tiersResult.tiers,
      popupText: popupText && String(popupText).trim() ? String(popupText).trim() : null,
      createdAt: new Date().toISOString(),
      createdBy: session.name,
    };

    // ── ปิดใช้งาน popup เก่าอัตโนมัติ (ไม่ลบข้อมูล แค่ปิดไว้) ──
    // สำคัญมาก: ทำเฉพาะตอนโปรใหม่นี้มีเนื้อหา popup ตั้งไว้จริง (รูป/วิดีโอ/QR/
    // ข้อความ) เท่านั้น — ป้องกันไม่ให้มีหลาย popup แข่งกันโชว์บนหน้าแรกพร้อม
    // กัน ทำให้สับสนว่าจะโชว์อันไหน (บั๊กที่เจอมาก่อนหน้านี้) — ปิดแค่โปรทั่วไป
    // ที่มี popup เหมือนกันเท่านั้น "ไม่แตะคูปองส่วนตัวของลูกค้าเด็ดขาด"
    // (restrictedToUserId) เพราะเป็นสิทธิ์ที่ลูกค้าสะสมมาเอง ไม่เกี่ยวอะไรกับ
    // การสร้างโปรโมชั่นทั่วไปใหม่เลย ถ้าไปปิดจะทำให้ลูกค้าเสียสิทธิ์ไปฟรีๆ
    const newPromoHasPopup = !!(newPromo.popupImageUrl || newPromo.popupVideoUrl || newPromo.popupQrData || newPromo.popupText);
    if (newPromoHasPopup) {
      let deactivatedCount = 0;
      for (const p of promotions) {
        if (p.restrictedToUserId || p.linkedGameId) continue; // ไม่แตะคูปองส่วนตัวลูกค้า และไม่แตะโค้ดรางวัลจากการเล่นเกมเด็ดขาด
        const pHasPopup = !!(p.popupImageUrl || p.popupVideoUrl || p.popupQrData || p.popupText);
        if (pHasPopup && p.active && p.code !== newPromo.code) {
          p.active = false;
          deactivatedCount++;
        }
      }
      if (deactivatedCount > 0) {
        logAdminAction(session.name, `ปิดใช้งาน popup เก่าอัตโนมัติ (${deactivatedCount} รายการ) เพราะสร้าง popup ใหม่`, {});
      }
    }

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
    if (body.gameRewardTiers !== undefined) {
      const patchTiersResult = validateGameRewardTiers(body.gameRewardTiers);
      if (patchTiersResult.error) { res.status(400).json({ error: patchTiersResult.error }); return; }
      body.gameRewardTiers = patchTiersResult.tiers;
    }

    const allowedFields = ["type", "value", "startDate", "endDate", "minOrderValue", "maxUses", "active", "gameUrl", "gameLabel", "popupImageUrl", "popupVideoUrl", "popupQrData", "popupText", "gameRewardTiers"];
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
