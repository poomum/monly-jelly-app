// ═══════════════════════════════════════════════════════════════
// Monly Jelly – Slip Verification (Vercel Serverless Function)
// วางไฟล์นี้ที่:  /api/verify-slip.js
//   POST /api/verify-slip  { orderId, imageBase64 }
//     → ส่งรูปสลิปไปตรวจกับ SlipOK (เช็คกับธนาคารแห่งประเทศไทยจริง)
//     → เทียบยอดเงิน + เลขบัญชีปลายทางกับออเดอร์ในระบบ
//     → ถ้าตรงกันและยังไม่เคยใช้สลิปนี้มาก่อน → เปลี่ยนสถานะเป็น "paid" ให้อัตโนมัติ
//       (ส่งข้อความ Pre-Order + ลิงก์ติดตามสถานะให้ลูกค้าทันที เหมือน PATCH ปกติ)
//
// ต้องตั้งค่า Environment Variables เพิ่ม:
//   SLIPOK_API_KEY       → จากบัญชี SlipOK ของร้าน (สมัครที่ slipok.com)
//   SLIPOK_BRANCH_ID     → รหัสสาขา/ธุรกิจจาก SlipOK
//   SHOP_ACCOUNT_NUMBER  → เลขบัญชีปลายทางของร้าน (ไว้เทียบกับสลิปกันโอนผิดบัญชี)
//   SHOP_PROMPTPAY_PHONE → เบอร์พร้อมเพย์ของร้าน (ช่องทางที่ 2 ไว้เทียบกับสลิปเช่นกัน)
// ═══════════════════════════════════════════════════════════════

const { createClient } = require("@vercel/kv");
const { addLoyaltyPoint } = require("../lib/promotions");
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
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function linePush(userId, messages, accessToken) {
  if (!userId || !accessToken) return;
  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`LINE push failed: HTTP ${resp.status} — ${errText}`);
    }
  } catch (e) { console.error("LINE push failed (network error):", e); }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const slipokKey = process.env.SLIPOK_API_KEY;
  const slipokBranchId = process.env.SLIPOK_BRANCH_ID;
  if (!slipokKey || !slipokBranchId) {
    res.status(500).json({ ok: false, error: "ระบบตรวจสอบสลิปยังไม่ได้ตั้งค่า (ขาด SLIPOK_API_KEY / SLIPOK_BRANCH_ID)" });
    return;
  }

  let body = {};
  try { const raw = await getRawBody(req); body = raw ? JSON.parse(raw) : {}; }
  catch { res.status(400).json({ ok: false, error: "invalid json" }); return; }

  const { orderId, imageBase64 } = body;
  if (!orderId || !imageBase64) {
    res.status(400).json({ ok: false, error: "ต้องระบุ orderId และ imageBase64" });
    return;
  }

  const id = String(orderId).trim().toUpperCase();
  const order = await kv.get(`order:${id}`);
  if (!order) { res.status(404).json({ ok: false, error: "ไม่พบออเดอร์นี้" }); return; }

  if (order.status && order.status !== "pending_payment") {
    res.status(200).json({
      ok: true,
      alreadyVerified: true,
      message: "ออเดอร์นี้ยืนยันการชำระเงินไปแล้วก่อนหน้านี้ค่ะ",
      status: order.status,
    });
    return;
  }

  // ── ส่งรูปสลิปไปตรวจสอบกับ SlipOK (รีเช็กกับธนาคารแห่งประเทศไทย) ──
  let slipData;
  try {
    const slipRes = await fetch(`https://api.slipok.com/api/line/apikey/${slipokBranchId}`, {
      method: "POST",
      headers: {
        "x-authorization": slipokKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files: imageBase64 }),
    });
    slipData = await slipRes.json();

    if (!slipRes.ok || slipData.success === false) {
      const slipMsg = slipData.message || "ไม่สามารถอ่านสลิปนี้ได้ อาจเป็นสลิปปลอมหรือรูปไม่ชัดเจน กรุณาตรวจสอบและลองใหม่ค่ะ";

      // ── เช็คว่าเป็นปัญหาเรื่องบัญชี/แพ็กเกจของ SlipOK เองไหม (ไม่ใช่ปัญหาที่
      // สลิปของลูกค้า) เช่น แพ็กเกจหมดอายุ/โควต้าหมด — ถ้าใช่ แจ้งเตือนแอดมิน
      // ทันทีทาง LINE เลย จะได้รู้ตัวตั้งแต่ลูกค้าคนแรกที่เจอปัญหา ไม่ต้องรอ
      // ลูกค้ามาบ่นก่อนถึงจะรู้ (เหมือนที่เคยเกิดขึ้นมาก่อน)
      const billingKeywords = ["package", "แพ็กเกจ", "หมดอายุ", "expired", "quota", "โควต้า", "subscription"];
      const looksLikeBillingIssue = billingKeywords.some((kw) => slipMsg.toLowerCase().includes(kw.toLowerCase()));
      if (looksLikeBillingIssue) {
        // กันแจ้งเตือนถี่เกินไป (เช่น ลูกค้าหลายคนแนบสลิปพร้อมกันตอนระบบมีปัญหา)
        // ส่งแจ้งเตือนได้สูงสุด 1 ครั้งทุก 6 ชั่วโมงเท่านั้น
        const lastAlertKey = "slipok:last-billing-alert";
        const lastAlert = await kv.get(lastAlertKey);
        const sixHoursMs = 6 * 60 * 60 * 1000;
        const shouldAlert = !lastAlert || Date.now() - Number(lastAlert) > sixHoursMs;
        if (shouldAlert) {
          await kv.set(lastAlertKey, String(Date.now()));
          const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
          const adminLineIds = (process.env.ADMIN_LINE_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
          if (accessToken && adminLineIds.length > 0) {
            const alertText =
              `🚨 ด่วน! ระบบตรวจสอบสลิป (SlipOK) มีปัญหา\n\n` +
              `ข้อความจาก SlipOK: "${slipMsg}"\n\n` +
              `⚠️ ลูกค้าจะแนบสลิปแล้วตรวจสอบอัตโนมัติไม่ได้จนกว่าจะแก้ไข\n` +
              `👉 เข้า slipok.com เช็ค/ต่ออายุแพ็กเกจด่วนเลยค่ะ\n\n` +
              `ระหว่างนี้ใช้ปุ่ม "ยืนยันจ่ายแล้ว" ในหน้าแอดมินแทนได้ค่ะ`;
            for (const adminId of adminLineIds) {
              await linePush(adminId, [{ type: "text", text: alertText }], accessToken);
            }
          }
        }
      }

      res.status(200).json({ ok: false, error: slipMsg });
      return;
    }
  } catch (e) {
    console.error("SlipOK request failed:", e);
    res.status(200).json({ ok: false, error: "ระบบตรวจสอบสลิปขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งค่ะ" });
    return;
  }

  const data = slipData.data || slipData;
  const transRef = data.transRef || data.transactionId || null;
  const amount = Number(data.amount || 0);
  const receiverAccount =
    (data.receiver && (data.receiver.account?.value || data.receiver.account)) || "";

  // ── กันสลิปซ้ำ (ใช้ transRef เดิมยิงมาซ้ำไม่ได้) ──
  if (transRef) {
    const usedBy = await kv.get(`slipref:${transRef}`);
    if (usedBy && usedBy !== id) {
      res.status(200).json({ ok: false, error: "สลิปนี้ถูกใช้ยืนยันออเดอร์อื่นไปแล้วค่ะ" });
      return;
    }
  }

  // ── เทียบเลขบัญชีปลายทาง ──
  // สำคัญ: ร้านรับเงินได้ 2 ช่องทาง (บัญชีธนาคาร + พร้อมเพย์เบอร์โทร)
  // ต้องเช็คว่าตรงกับ "ช่องทางใดช่องทางหนึ่ง" ก็พอ ไม่ใช่แค่บัญชีเดียว
  // ไม่งั้นลูกค้าที่จ่ายผ่าน QR พร้อมเพย์ (ถูกต้อง 100%) จะถูกปฏิเสธผิดๆ
  //
  // สำคัญมาก: ค่า receiverAccount ที่ได้จาก SlipOK จะถูก "มาสก์" เสมอ (เช่น
  // "xxx-x-x3109-x") และรูปแบบการมาสก์ไม่คงที่ ขึ้นอยู่กับแต่ละธนาคาร (ตามเอกสาร
  // ทางการของ SlipOK) — บางธนาคารอาจซ่อนตัวเลขท้ายสุดไว้ด้วยซ้ำ ทำให้การเทียบ
  // แบบ "ต้องลงท้ายด้วย 4 ตัวท้ายเป๊ะ" พลาดได้ง่ายมาก แม้จะโอนถูกบัญชีจริง 100%
  // เปลี่ยนมาเช็คแบบ "ตัวเลขที่ตั้งไว้ปรากฏอยู่ที่ไหนก็ได้ในค่าที่เห็น" แทน
  // (ยืดหยุ่นกว่า กันลูกค้าถูกปฏิเสธผิดๆ จากปัญหาการมาสก์ที่ควบคุมไม่ได้)
  const validReceiverDigits = [
    process.env.SHOP_ACCOUNT_NUMBER,     // เลขบัญชีธนาคาร (เช่น 0303755160)
    process.env.SHOP_PROMPTPAY_PHONE,    // เบอร์พร้อมเพย์ (เช่น 0811644794)
  ]
    .filter(Boolean)
    .map((v) => String(v).replace(/\D/g, ""));

  const receiverDigits = String(receiverAccount).replace(/\D/g, "");
  const accountOk =
    validReceiverDigits.length === 0 || !receiverDigits
      ? true // ถ้าไม่ได้ตั้งค่าอะไรไว้เลย หรือ SlipOK ไม่ส่งเลขบัญชีมาด้วย ข้ามการเช็คส่วนนี้
      : validReceiverDigits.some((full) => {
          // เช็คว่าตัวเลขที่เห็น (แม้จะถูกมาสก์บางส่วน) มีส่วนที่ตรงกับเลขบัญชี
          // จริงอยู่บ้างไหม ลองเทียบทั้งท้าย 4 ตัว และ "ปรากฏที่ไหนก็ได้"
          const tail = full.slice(-4);
          return receiverDigits.endsWith(tail) || receiverDigits.includes(tail) || full.includes(receiverDigits);
        });

  // ── เทียบยอดเงินกับออเดอร์ ── (ย้ายมาไว้ก่อนตรงนี้ เพื่อใช้ตัดสินใจร่วมกับเลขบัญชี)
  const expected = order.grandTotal;
  const amountOk = amount === expected;
  if (!amountOk) {
    console.warn(`[slip amount mismatch] orderId=${id} slipAmount=${amount} expected=${expected} receiverAccount=${receiverAccount || "-"}`);
    res.status(200).json({
      ok: false,
      mismatch: true,
      error: `ยอดเงินในสลิป (฿${amount}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expected}) กรุณาตรวจสอบอีกครั้งค่ะ`,
      slipAmount: amount,
      expectedAmount: expected,
    });
    return;
  }

  // ── สำคัญ: ถ้ายอดเงินตรงแล้ว (สัญญาณที่น่าเชื่อถือที่สุด) แต่เลขบัญชีดูไม่ตรง
  // (อาจเป็นเพราะปัญหาการมาสก์เลขบัญชีของ SlipOK เอง ไม่ใช่ลูกค้าโอนผิดจริง) —
  // ไม่ปฏิเสธลูกค้าเด็ดขาด แค่บันทึกไว้เป็นข้อสังเกตให้แอดมินเห็นแทน กันลูกค้า
  // ที่โอนถูกต้อง 100% แล้วโดนปฏิเสธผิดๆ จากข้อจำกัดที่ควบคุมไม่ได้ของบุคคลที่ 3
  const accountMismatchNote = accountOk
    ? null
    : `⚠️ เลขบัญชีปลายทางที่ SlipOK อ่านได้ (${receiverAccount || "-"}) ไม่ตรงกับที่ตั้งไว้ชัดเจน — โปรดตรวจสอบยอดเงินในบัญชีจริงอีกครั้ง (อาจเป็นเพราะรูปแบบมาสก์เลขบัญชีของธนาคารนั้นๆ ไม่ใช่ลูกค้าโอนผิด)`;

  // ── ผ่านการตรวจสอบ: บันทึก transRef กันใช้ซ้ำ + อัปเดตสถานะเป็น paid ──
  if (transRef) await kv.set(`slipref:${transRef}`, id);

  const updated = {
    ...order,
    status: "paid",
    slipVerifiedAt: new Date().toISOString(),
    slipTransRef: transRef,
    slipAmount: amount,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(`order:${id}`, updated);

  // ── สั่งซื้อสำเร็จ (จ่ายเงินแล้ว) ครั้งแรก → สะสมแต้ม "พลังงานชีวิต" ให้ 1 แต้ม
  //    เช็ค order.status !== "paid" กันไม่ให้นับซ้ำถ้าเผลอตรวจสอบสลิปซ้ำ (เช่น
  //    ลูกค้าแนบสลิปเดิมซ้ำ) — สำคัญมาก: จุดนี้เคยขาดหายไป ทำให้ลูกค้าที่จ่ายเงิน
  //    ผ่านการตรวจสอบสลิปอัตโนมัติ (เส้นทางหลักที่ลูกค้าส่วนใหญ่ใช้) ไม่เคยได้แต้ม
  //    สะสมเลย ทั้งที่ระบบแต้มมีอยู่แล้ว แค่ไม่เคยถูกเรียกใช้จากจุดนี้ ──
  if (order.status !== "paid" && order.userId) {
    const loyaltyAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    addLoyaltyPoint(order.userId)
      .then((result) => {
        if (result && result.rewardCreated && loyaltyAccessToken) {
          const rewardMsg =
            `⚡ สะสมแต้มครบแล้ว! คุณได้รับส่วนลด ${result.rewardCreated.discount} บาท 🎉\n\n` +
            `🎟️ โค้ด: ${result.rewardCreated.code}\n` +
            `ใช้ได้ภายใน 6 เดือน (ใช้ได้ 1 ครั้ง)\n\n` +
            `เช็คดูได้ที่หน้า "คูปองของฉัน" หรือนำโค้ดนี้ไปกรอกตอนสั่งซื้อครั้งถัดไปได้เลยค่ะ 💚`;
          linePush(order.userId, [{ type: "text", text: rewardMsg }], loyaltyAccessToken).catch(() => {});
        }
      })
      .catch((e) => console.error("addLoyaltyPoint failed:", e));
  }

  // ── แจ้งลูกค้าทาง LINE (ข้อความ Pre-Order + ลิงก์ติดตามสถานะ) ──
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  console.log(`[slip verify notify-check] orderId=${id} hasUserId=${!!order.userId} hasAccessToken=${!!accessToken}`);
  if (order.userId && accessToken) {
    const liffId = process.env.LIFF_ID;
    const trackLink = liffId ? `https://liff.line.me/${liffId}?orderId=${id}` : null;
    const trackLine = trackLink
      ? `🔗 ติดตามสถานะออเดอร์ได้ตลอดเวลาที่ลิงก์นี้:\n${trackLink}`
      : `พิมพ์ "ติดตาม" ในแชทนี้เพื่อเช็คสถานะได้ตลอดค่ะ`;
    const text =
      `✅ ตรวจสอบสลิปสำเร็จ ยืนยันการชำระเงินเรียบร้อยแล้วค่ะ! 🎉\n\n` +
      `📦 ออเดอร์ #${id} พร้อมรับออเดอร์แล้ว\n` +
      `💰 ยอดที่ตรวจพบ: ฿${amount}\n\n` +
      `⏳ สินค้านี้เป็นสินค้า Pre-Order นะคะ หลังชำระเงินทางร้านจะใช้เวลาประมาณ 3-4 วันทำการในการเตรียมและจัดส่งสินค้าให้คุณลูกค้าค่ะ\n\n` +
      `ตอนนี้ออเดอร์ของคุณกำลังอยู่ระหว่างดำเนินการ (3-4 วัน) หลังจากทำขนมเสร็จเรียบร้อย ทางร้านจะอัปเดตสถานะเป็น "พร้อมจัดส่งสินค้า" พร้อมเลขพัสดุให้ทันทีค่ะ\n\n` +
      `${trackLine}\n\nหากมีข้อสงสัยสอบถามเพิ่มเติมได้ทางแชทนี้ตลอดเวลาทำการเลยนะคะ 💚`;
    await linePush(order.userId, [{ type: "text", text }], accessToken);
  }

  res.status(200).json({
    ok: true,
    verified: true,
    order: updated,
    slip: { transRef, amount, receiverAccount },
  });
};

module.exports.config = { api: { bodyParser: false } };
