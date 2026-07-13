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
//   SLIPOK_API_KEY      → จากบัญชี SlipOK ของร้าน (สมัครที่ slipok.com)
//   SLIPOK_BRANCH_ID    → รหัสสาขา/ธุรกิจจาก SlipOK
//   SHOP_ACCOUNT_NUMBER → เลขบัญชีปลายทางของร้าน (ไว้เทียบกับสลิปกันโอนผิดบัญชี)
// ═══════════════════════════════════════════════════════════════

const { kv } = require("@vercel/kv");

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports.config = { api: { bodyParser: false } };

async function linePush(userId, messages, accessToken) {
  if (!userId || !accessToken) return;
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: userId, messages }),
    });
  } catch (e) { console.error("LINE push failed:", e); }
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
      res.status(200).json({
        ok: false,
        error: slipData.message || "ไม่สามารถอ่านสลิปนี้ได้ อาจเป็นสลิปปลอมหรือรูปไม่ชัดเจน กรุณาตรวจสอบและลองใหม่ค่ะ",
      });
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

  // ── เทียบยอดเงินกับออเดอร์ ──
  const expected = Number(order.grandTotal || 0);
  const amountOk = Math.abs(amount - expected) < 0.5; // กันปัดเศษสตางค์

  // ── เทียบเลขบัญชีปลายทาง (ถ้าตั้งค่า SHOP_ACCOUNT_NUMBER ไว้) ──
  const shopAccount = process.env.SHOP_ACCOUNT_NUMBER;
  const accountOk = !shopAccount || !receiverAccount
    ? true // ถ้าไม่ได้ตั้งค่าไว้ ข้ามการเช็คส่วนนี้
    : String(receiverAccount).replace(/\D/g, "").endsWith(String(shopAccount).replace(/\D/g, "").slice(-4));

  if (!amountOk || !accountOk) {
    res.status(200).json({
      ok: false,
      mismatch: true,
      error: !amountOk
        ? `ยอดเงินในสลิป (฿${amount}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expected}) กรุณาตรวจสอบอีกครั้งค่ะ`
        : "บัญชีปลายทางในสลิปไม่ตรงกับบัญชีร้านค้า กรุณาตรวจสอบว่าโอนถูกบัญชีหรือไม่ค่ะ",
      slipAmount: amount,
      expectedAmount: expected,
    });
    return;
  }

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

  // ── แจ้งลูกค้าทาง LINE (ข้อความ Pre-Order + ลิงก์ติดตามสถานะ) ──
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
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
