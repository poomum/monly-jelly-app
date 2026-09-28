// ═══════════════════════════════════════════════════════════════
// Monly Jelly – ไลบรารีกลางสำหรับสรุปประวัติการสั่งซื้อของลูกค้า
// วางไฟล์นี้ที่: /lib/purchaseHistory.js (นอกโฟลเดอร์ api/)
//
// ข้อมูลนี้ไม่ได้เก็บแยกต่างหาก แต่คำนวณสดจากออร์เดอร์จริงทุกใบ
// ของลูกค้าคนนั้น (orders:user:{userId}) เพื่อไม่ให้ข้อมูลสองชุด
// ไม่ตรงกันในอนาคต (แหล่งความจริงเดียว = ออร์เดอร์จริงเท่านั้น)
// ═══════════════════════════════════════════════════════════════

const { kv } = require("./adminAuth");

const FLAVOR_NAMES = {
  beet: "BeetRoot – บีทรูท",
  matcha: "Matcha – มัทฉะ",
  butter: "Butterfly Pea – อัญชัน",
  mix: "ซองรวม 3 รส",
};

// ดึงประวัติการสั่งซื้อทั้งหมดของลูกค้าคนหนึ่ง + สรุปสถิติแยกตามรสชาติ
// นับเฉพาะออร์เดอร์ที่จ่ายเงินแล้วจริง (status: paid หรือ shipped) เป็นหลัก
// แต่ก็แสดง pending ให้เห็นแยกไว้ด้วยเผื่ออยากรู้
async function getCustomerPurchaseHistory(userId) {
  const orderIds = (await kv.smembers(`orders:user:${userId}`)) || [];
  const orders = (await Promise.all(orderIds.map((id) => kv.get(`order:${id}`)))).filter(Boolean);

  orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const flavorCounts = {}; // { beet: 3, matcha: 5, ... } นับจำนวนชิ้นรวม
  const flavorOrderCounts = {}; // { beet: 2, matcha: 4, ... } นับจำนวนครั้งที่สั่ง (ไม่ว่าจะกี่ชิ้น)
  let totalSpent = 0;
  let paidOrderCount = 0;

  for (const order of orders) {
    const isPaidOrShipped = order.status === "paid" || order.status === "shipped";
    if (!isPaidOrShipped) continue; // นับเฉพาะออร์เดอร์ที่จ่ายเงินแล้วจริงเท่านั้น

    paidOrderCount++;
    totalSpent += Number(order.grandTotal) || 0;

    const seenFlavorsThisOrder = new Set();
    for (const item of order.items || []) {
      flavorCounts[item.id] = (flavorCounts[item.id] || 0) + (item.qty || 0);
      seenFlavorsThisOrder.add(item.id);
    }
    for (const flavorId of seenFlavorsThisOrder) {
      flavorOrderCounts[flavorId] = (flavorOrderCounts[flavorId] || 0) + 1;
    }
  }

  // หารสที่สั่งบ่อยที่สุด (นับจากจำนวนชิ้นรวม)
  let favoriteFlavor = null;
  let maxCount = 0;
  for (const [flavorId, count] of Object.entries(flavorCounts)) {
    if (count > maxCount) {
      maxCount = count;
      favoriteFlavor = flavorId;
    }
  }

  const flavorBreakdown = Object.entries(flavorCounts).map(([flavorId, qty]) => ({
    id: flavorId,
    name: FLAVOR_NAMES[flavorId] || flavorId,
    totalQty: qty,
    orderCount: flavorOrderCounts[flavorId] || 0,
  })).sort((a, b) => b.totalQty - a.totalQty);

  const paidOrders = orders.filter((o) => o.status === "paid" || o.status === "shipped");

  return {
    userId,
    totalOrders: orders.length,
    paidOrderCount,
    totalSpent,
    favoriteFlavor: favoriteFlavor ? { id: favoriteFlavor, name: FLAVOR_NAMES[favoriteFlavor] || favoriteFlavor } : null,
    flavorBreakdown,
    firstPurchaseDate: paidOrders.length ? paidOrders[paidOrders.length - 1].createdAt : null,
    lastPurchaseDate: paidOrders.length ? paidOrders[0].createdAt : null,
    recentOrders: orders.slice(0, 10), // 10 ออร์เดอร์ล่าสุด (ทุกสถานะ) ไว้ดูรายละเอียด
  };
}

module.exports = {
  FLAVOR_NAMES,
  getCustomerPurchaseHistory,
};
