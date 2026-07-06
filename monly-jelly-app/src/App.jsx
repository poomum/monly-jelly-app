import { useState, useEffect } from "react";

// ── Config ─────────────────────────────────────────
const LIFF_ID = "2010516208";
// ⚠️ สำคัญ: ".railway.internal" เป็น Private Domain (เบราว์เซอร์ลูกค้าเข้าไม่ได้!)
// ต้องใช้ Public Domain แทน โดยไป Railway → Settings → Networking → Generate Domain
// จะได้แบบ: "https://welcoming-imagination.up.railway.app"
const SERVER_URL = "https://welcoming-imagination.railway.internal";
const PROMPTPAY_ID = "0811644794";
const PROMPTPAY_NAME = "Monly Jelly";

function generatePromptPayQR(amount) {
  return `https://api.promptpay.io/${PROMPTPAY_ID}/${amount}`;
}

// ── Color Palette ──────────────────────────────────
const C = {
  pink: "#FF6B9D", purple: "#7B5EA7", beet: "#C0394B",
  matcha: "#3A7D44", butterfly: "#4A3882",
  lightPink: "#FFE0EF", lightPurple: "#EDD6FF",
  cream: "#FFF8FC", dark: "#2D2233", gray: "#9a8aaa",
  red: "#E24B4A", green: "#0F6E56",
};

// ── Data ───────────────────────────────────────────
const ROUNDS = [
  { id: "R001", label: "รอบที่ 1", date: "20 ก.ค. 2026", slots: 10, booked: 10, closed: true },
  { id: "R002", label: "รอบที่ 2", date: "27 ก.ค. 2026", slots: 10, booked: 8, closed: false },
  { id: "R003", label: "รอบที่ 3", date: "3 ส.ค. 2026", slots: 10, booked: 4, closed: false },
  { id: "R004", label: "รอบที่ 4", date: "10 ส.ค. 2026", slots: 10, booked: 0, closed: false },
];

const FLAVORS = [
  { id: "beet", emoji: "🔴", name: "BeetRoot", nameTh: "บีทรูท+มะนาว", price: 89, color: C.beet },
  { id: "matcha", emoji: "🟢", name: "Matcha", nameTh: "มัทฉะ+มะนาว", price: 89, color: C.matcha },
  { id: "butterfly", emoji: "🟣", name: "Butterfly Pea", nameTh: "ดอกอัญชัน+มะนาว", price: 89, color: C.butterfly },
];

const BUNDLES = [
  { id: "mixbag12", emoji: "🎁", name: "ซองรวม 3 รส", nameTh: "BeetRoot/Matcha/Butterfly Pea", price: 189, color: C.purple },
];

const SHIPPING = [
  { id: "standard", label: "ธรรมดา", detail: "3–5 วัน", price: 50, icon: "📮" },
  { id: "fast", label: "เร็ว (EMS)", detail: "2–3 วัน", price: 60, icon: "⚡" },
];

const STATUS_STEPS = ["ยืนยันออเดอร์", "กำลังผลิต", "แพ็กสินค้า", "ส่งแล้ว", "ถึงมือคุณ"];

// ── Components ─────────────────────────────────────
function Badge({ children, color = C.pink, bg = "#FFE0EF" }) {
  return <span style={{ background: bg, color, borderRadius: 99, padding: "4px 12px", fontSize: 12, fontWeight: 700, display: "inline-block" }}>{children}</span>;
}

function Card({ children, style }) {
  return <div style={{ background: "#fff", borderRadius: 20, boxShadow: "0 2px 16px #7B5EA718", padding: "16px", marginBottom: 14, ...style }}>{children}</div>;
}

// ── Queue Page ─────────────────────────────────────
function QueuePage({ onBook, rounds }) {
  const bestRound = rounds.reduce((best, r) => {
    if (r.closed) return best;
    const bestSlots = best.slots - best.booked;
    const currentSlots = r.slots - r.booked;
    return currentSlots > bestSlots ? r : best;
  }, null);

  return (
    <div>
      <div style={{ textAlign: "center", padding: "24px 0 12px" }}>
        <div style={{ fontSize: 32 }}>📅</div>
        <h2 style={{ fontSize: 20, fontWeight: 900, color: C.dark, margin: "6px 0 4px" }}>จองคิวผลิต</h2>
        <p style={{ fontSize: 13, color: C.gray }}>เลือกรอบที่ต้องการจอง</p>
      </div>

      {rounds.map(r => {
        const left = r.slots - r.booked;
        const full = left === 0;
        const isBest = bestRound && r.id === bestRound.id;

        return (
          <Card key={r.id} style={isBest ? { borderLeft: "4px solid " + C.green, background: "#f0f8f5" } : {}}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: C.dark }}>{r.label}</div>
                <div style={{ fontSize: 13, color: C.gray, marginTop: 2 }}>📦 ส่งประมาณ {r.date}</div>
                {isBest && !full && <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginTop: 4 }}>✅ ควรจองอันนี้! ยังมีที่ว่างเยอะสุด</div>}
              </div>
              {full ? <Badge color="#fff" bg={C.red}>เต็มแล้ว</Badge> : <Badge color="#fff" bg={C.green}>ว่าง {left} ที่</Badge>}
            </div>

            <div style={{ fontSize: 13, color: C.dark, fontWeight: 700, marginBottom: 10 }}>{r.booked}/{r.slots} ออเดอร์ ({left} ที่ว่าง)</div>

            {!full && (
              <button onClick={() => onBook(r)} style={{ width: "100%", padding: "13px 0", background: isBest ? `linear-gradient(135deg, ${C.green}, #2d9e4e)` : `linear-gradient(135deg, ${C.pink}, ${C.purple})`, color: "#fff", border: "none", borderRadius: 12, fontWeight: 800, fontSize: 16, cursor: "pointer" }}>
                จองรอบนี้ →
              </button>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ── Order Form ─────────────────────────────────────
function OrderForm({ round, onSubmit, onBack }) {
  const [cart, setCart] = useState({ beet: 0, matcha: 0, butterfly: 0 });
  const [bundles, setBundles] = useState({ mixbag12: 0 });
  const [ship, setShip] = useState("standard");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [addr, setAddr] = useState("");
  const [errors, setErrors] = useState({});

  const totalQty = Object.values(cart).reduce((a,b) => a+b, 0) + Object.values(bundles).reduce((a,b) => a+b, 0);
  const itemTotal = FLAVORS.reduce((s, f) => s + (cart[f.id] * f.price), 0);
  const bundleTotal = BUNDLES.reduce((s, b) => s + (bundles[b.id] * b.price), 0);
  const shipPrice = SHIPPING.find(s => s.id === ship)?.price || 0;
  const subtotal = itemTotal + bundleTotal;
  const grandTotal = subtotal + shipPrice;

  function validate() {
    const newErrors = {};
    if (!name?.trim()) newErrors.name = "กรุณากรอกชื่อ";
    if (!phone?.trim()) newErrors.phone = "กรุณากรอกเบอร์โทร";
    if (!addr?.trim()) newErrors.addr = "กรุณากรอกที่อยู่";
    if (totalQty === 0) newErrors.qty = "กรุณาเลือกสินค้า";
    return newErrors;
  }

  function handleSubmit() {
    const newErrors = validate();
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    onSubmit({ round, cart, bundles, ship, name, phone, addr, grandTotal });
  }

  return (
    <div>
      <button onClick={onBack} style={{ background: "none", border: "none", color: C.purple, fontWeight: 700, fontSize: 15, cursor: "pointer", marginBottom: 8 }}>← กลับ</button>

      <div style={{ background: `linear-gradient(135deg, ${C.lightPink}, ${C.lightPurple})`, borderRadius: 16, padding: "14px 16px", marginBottom: 16, textAlign: "center" }}>
        <div style={{ fontWeight: 900, color: C.dark, fontSize: 16 }}>{round.label} – {round.date}</div>
        <div style={{ fontSize: 13, color: C.gray }}>เหลือ {round.slots - round.booked} ที่ว่าง</div>
      </div>

      {/* Bundles */}
      <Card style={{ background: `linear-gradient(135deg, #FFF0F6, ${C.lightPurple})` }}>
        <div style={{ fontWeight: 800, marginBottom: 12, color: C.dark }}>🎁 แพ็กเกจสุดคุ้ม</div>
        {BUNDLES.map(b => (
          <div key={b.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <span style={{ fontSize: 20, marginRight: 8 }}>{b.emoji}</span>
              <span style={{ fontWeight: 700 }}>{b.name}</span>
              <div style={{ fontSize: 11, color: C.gray, marginLeft: 28 }}>{b.nameTh} · ฿{b.price}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setBundles(b => ({ ...b, [b.id]: Math.max(0, b[b.id] - 1) }))} style={{ width: 44, height: 44, borderRadius: 8, border: `2px solid ${C.purple}`, background: "none", color: C.purple, fontWeight: 800, cursor: "pointer", fontSize: 18 }}>−</button>
              <span style={{ fontWeight: 800, minWidth: 24, textAlign: "center", fontSize: 16 }}>{bundles[b.id]}</span>
              <button onClick={() => setBundles(b => ({ ...b, [b.id]: b[b.id] + 1 }))} style={{ width: 44, height: 44, borderRadius: 8, border: "none", background: C.purple, color: "#fff", fontWeight: 800, cursor: "pointer", fontSize: 18 }}>+</button>
            </div>
          </div>
        ))}
      </Card>

      {/* Flavors */}
      <Card>
        <div style={{ fontWeight: 800, marginBottom: 12, color: C.dark }}>🧃 เลือกซื้อแยกรส</div>
        {FLAVORS.map(f => (
          <div key={f.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <span style={{ fontSize: 20, marginRight: 8 }}>{f.emoji}</span>
              <span style={{ fontWeight: 700 }}>{f.name}</span>
              <div style={{ fontSize: 11, color: C.gray, marginLeft: 28 }}>฿{f.price}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setCart(c => ({ ...c, [f.id]: Math.max(0, c[f.id] - 1) }))} style={{ width: 44, height: 44, borderRadius: 8, border: `2px solid ${C.purple}`, background: "none", color: C.purple, fontWeight: 800, cursor: "pointer", fontSize: 18 }}>−</button>
              <span style={{ fontWeight: 800, minWidth: 24, textAlign: "center", fontSize: 16 }}>{cart[f.id]}</span>
              <button onClick={() => setCart(c => ({ ...c, [f.id]: c[f.id] + 1 }))} style={{ width: 44, height: 44, borderRadius: 8, border: "none", background: C.purple, color: "#fff", fontWeight: 800, cursor: "pointer", fontSize: 18 }}>+</button>
            </div>
          </div>
        ))}
      </Card>

      {/* Shipping */}
      <Card>
        <div style={{ fontWeight: 800, marginBottom: 12, color: C.dark }}>🚚 เลือกการจัดส่ง</div>
        {SHIPPING.map(s => (
          <div key={s.id} onClick={() => setShip(s.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px", borderRadius: 12, marginBottom: 10, cursor: "pointer", border: `2.5px solid ${ship === s.id ? C.purple : "#e8e0f0"}`, background: ship === s.id ? C.lightPurple : "#fafafa" }}>
            <span style={{ fontSize: 24 }}>{s.icon}</span>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 15 }}>{s.label}</div><div style={{ fontSize: 12, color: C.gray }}>{s.detail}</div></div>
            <div style={{ fontWeight: 800, color: C.dark, fontSize: 15 }}>+฿{s.price}</div>
          </div>
        ))}
      </Card>

      {/* Contact */}
      <Card>
        <div style={{ fontWeight: 800, marginBottom: 12, color: C.dark }}>👤 ข้อมูลผู้รับ</div>
        {[{ label: "ชื่อ-นามสกุล *", val: name, set: setName, key: "name" },
          { label: "เบอร์โทร *", val: phone, set: setPhone, key: "phone" }].map(f => (
          <div key={f.key}>
            <label style={{ display: "block", fontWeight: 700, color: C.dark, marginBottom: 4, fontSize: 13 }}>{f.label}</label>
            <input value={f.val} onChange={e => f.set(e.target.value)} style={{ display: "block", width: "100%", padding: "13px 14px", borderRadius: 12, border: errors[f.key] ? `2px solid ${C.red}` : "1.5px solid #e0d6ee", fontSize: 14, boxSizing: "border-box", marginBottom: errors[f.key] ? 4 : 10 }} />
            {errors[f.key] && <div style={{ color: C.red, fontSize: 12, fontWeight: 600, marginBottom: 10 }}>⚠️ {errors[f.key]}</div>}
          </div>
        ))}
        <label style={{ display: "block", fontWeight: 700, color: C.dark, marginBottom: 4, fontSize: 13 }}>ที่อยู่จัดส่ง *</label>
        <textarea value={addr} onChange={e => setAddr(e.target.value)} rows={3} style={{ display: "block", width: "100%", padding: "13px 14px", borderRadius: 12, border: errors.addr ? `2px solid ${C.red}` : "1.5px solid #e0d6ee", fontSize: 14, boxSizing: "border-box", marginBottom: errors.addr ? 4 : 10 }} />
        {errors.addr && <div style={{ color: C.red, fontSize: 12, fontWeight: 600, marginBottom: 10 }}>⚠️ {errors.addr}</div>}
      </Card>

      {/* Summary */}
      {totalQty > 0 && (
        <Card style={{ background: C.lightPurple }}>
          <div style={{ fontWeight: 800, marginBottom: 10, color: C.dark }}>🧾 สรุปออเดอร์</div>
          {BUNDLES.filter(b => bundles[b.id] > 0).map(b => <div key={b.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 4 }}><span>{b.emoji} {b.name} × {bundles[b.id]}</span><span>฿{bundles[b.id] * b.price}</span></div>)}
          {FLAVORS.filter(f => cart[f.id] > 0).map(f => <div key={f.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 4 }}><span>{f.emoji} {f.name} × {cart[f.id]}</span><span>฿{cart[f.id] * f.price}</span></div>)}
          <div style={{ borderTop: "1px dashed #c0b0d8", margin: "8px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.gray, marginBottom: 6 }}><span>รวมสินค้า</span><span>฿{subtotal}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.gray, marginBottom: 8 }}><span>{SHIPPING.find(s => s.id === ship)?.icon} ค่าจัดส่ง</span><span>฿{shipPrice}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 18, color: C.dark, padding: "10px", background: "rgba(255,255,255,.4)", borderRadius: 8 }}><span>ต้องชำระ</span><span style={{ color: C.red }}>฿{grandTotal}</span></div>
        </Card>
      )}

      <button onClick={handleSubmit} style={{ width: "100%", padding: "16px 0", borderRadius: 16, border: "none", background: totalQty > 0 ? `linear-gradient(135deg, ${C.pink}, ${C.purple})` : "#ddd", color: "#fff", fontWeight: 900, fontSize: 18, cursor: totalQty > 0 ? "pointer" : "not-allowed", marginBottom: 24 }}>
        {totalQty === 0 ? "กรุณาเลือกสินค้า" : "✅ ยืนยันจอง"}
      </button>
    </div>
  );
}

// ── Confirm Page ───────────────────────────────────
function ConfirmPage({ order, onDone }) {
  const paymentAmount = order.grandTotal;

  return (
    <div style={{ textAlign: "center", padding: "28px 16px" }}>
      <div style={{ fontSize: 64, marginBottom: 8 }}>🎉</div>
      <h2 style={{ fontSize: 22, fontWeight: 900, color: C.purple, margin: "0 0 8px" }}>จองสำเร็จ!</h2>
      <p style={{ color: C.gray, fontSize: 14, margin: "0 0 20px" }}>ขอบคุณที่สนับสนุน Monly Jelly นะคะ 💕</p>

      <Card style={{ textAlign: "left", background: C.lightPurple, marginBottom: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12, color: C.dark }}>🧾 Order #{order.id}</div>
        <div style={{ fontSize: 13, lineHeight: 2, color: C.dark }}>
          <div><b>รอบ:</b> {order.round.label}</div>
          <div><b>ชื่อ:</b> {order.name}</div>
          <div><b>เบอร์:</b> {order.phone}</div>
        </div>
        <div style={{ borderTop: "1px dashed #c0b0d8", margin: "10px 0" }} />
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          <b>สินค้า:</b><br/>
          {[...BUNDLES.filter(b => order.bundles?.[b.id] > 0).map(b => `${b.emoji}${b.name} ×${order.bundles[b.id]} = ฿${order.bundles[b.id] * b.price}`), ...FLAVORS.filter(f => order.cart[f.id] > 0).map(f => `${f.emoji}${f.name} ×${order.cart[f.id]} = ฿${order.cart[f.id] * f.price}`)].map((item, i) => <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>{item}</div>)}
        </div>
        <div style={{ borderTop: "1px dashed #c0b0d8", margin: "10px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 18, color: C.dark, marginBottom: 10 }}><span>รวมทั้งหมด</span><span style={{ color: C.purple }}>฿{order.grandTotal}</span></div>

        <div style={{ background: "rgba(255,255,255,.5)", borderRadius: 12, padding: "12px", border: `3px solid ${C.red}`, marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: C.red, marginBottom: 6 }}>💳 ต้องชำระเงินเต็มจำนวน</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: C.red, marginBottom: 6 }}>฿{paymentAmount}</div>
          <div style={{ fontSize: 12, color: C.gray }}>✅ เพื่อ lock สิทธิ์การจอง (ไม่มีการคืนเงิน)</div>
        </div>

        <div style={{ background: "#fff", borderRadius: 12, padding: 12, border: "1px dashed #c0b0d8" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.gray, marginBottom: 8, textAlign: "center" }}>📱 สแกน QR เพื่อชำระเงิน</div>
          <img src={generatePromptPayQR(paymentAmount)} alt="PromptPay QR" style={{ width: 160, height: 160, borderRadius: 12, margin: "0 auto", display: "block" }} />
          <div style={{ fontSize: 11, color: C.gray, textAlign: "center", marginTop: 8 }}>{PROMPTPAY_NAME} • {paymentAmount} บาท</div>
        </div>
      </Card>

      <button onClick={onDone} style={{ width: "100%", padding: "16px 0", borderRadius: 16, border: "none", background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`, color: "#fff", fontWeight: 900, fontSize: 16, cursor: "pointer", marginBottom: 12 }}>
        ดูสถานะออเดอร์ →
      </button>
    </div>
  );
}

// ── Tracking Page ──────────────────────────────────
function TrackingPage({ orders }) {
  if (orders.length === 0) return <div style={{ textAlign: "center", padding: "48px 24px", color: C.gray }}><div style={{ fontSize: 48 }}>📭</div><div style={{ fontWeight: 700, marginTop: 12, fontSize: 16 }}>ยังไม่มีออเดอร์</div></div>;

  return (
    <div>
      <div style={{ padding: "20px 0 12px", textAlign: "center" }}>
        <div style={{ fontSize: 32 }}>📍</div>
        <h2 style={{ fontSize: 20, fontWeight: 900, color: C.dark, margin: "6px 0 4px" }}>ติดตามสินค้า</h2>
      </div>
      {orders.map(order => (
        <Card key={order.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 16, color: C.dark, fontFamily: "monospace" }}>#{order.id}</div>
              <div style={{ fontSize: 12, color: C.gray }}>{order.round.label}</div>
            </div>
            <Badge color="#fff" bg={order.statusStep === 4 ? C.matcha : C.purple}>{STATUS_STEPS[order.statusStep]}</Badge>
          </div>
          <div style={{ background: C.lightPink, borderRadius: 12, padding: "10px 12px", fontSize: 13 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>{order.name} • {order.phone}</div>
            <div style={{ fontWeight: 800, color: C.purple }}>฿{order.grandTotal}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Root App ───────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("queue");
  const [rounds, setRounds] = useState(ROUNDS);
  const [orders, setOrders] = useState([]);
  const [booking, setBooking] = useState(null);
  const [confirmed, setConfirmed] = useState(null);

  function handleSubmit(data) {
    const orderId = "MJ" + Date.now().toString(36).toUpperCase().slice(-8);
    const newOrder = { ...data, id: orderId, statusStep: 0, createdAt: Date.now() };
    setOrders([newOrder, ...orders]);
    setRounds(rounds.map(r => r.id === data.round.id ? { ...r, booked: r.booked + 1 } : r));
    setBooking(null);
    setConfirmed(newOrder);
    setTab("confirm");
  }

  const NAV = [
    { id: "queue", label: "จองคิว", icon: "📅" },
    { id: "track", label: "ติดตาม", icon: "📍" },
  ];

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", background: C.cream, minHeight: "100vh", fontFamily: "'Helvetica Neue', sans-serif", position: "relative" }}>
      <div style={{ background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`, padding: "18px 20px 14px", color: "#fff", textAlign: "center" }}>
        <div style={{ fontSize: 12, opacity: 0.85, letterSpacing: 1, marginBottom: 2 }}>MONLY JELLY</div>
        <div style={{ fontWeight: 900, fontSize: 18 }}>
          {booking ? "สั่งจองสินค้า 🛒" : tab === "confirm" ? "จองสำเร็จ ✅" : tab === "queue" ? "จองคิว Pre-Order 📅" : "ติดตามสินค้า 📍"}
        </div>
      </div>

      <div style={{ padding: "0 16px 80px" }}>
        {tab === "confirm" && confirmed ? (
          <ConfirmPage order={confirmed} onDone={() => { setTab("track"); setConfirmed(null); }} />
        ) : booking ? (
          <OrderForm round={booking} onSubmit={handleSubmit} onBack={() => setBooking(null)} />
        ) : tab === "queue" ? (
          <QueuePage rounds={rounds} onBook={r => setBooking(r)} />
        ) : (
          <TrackingPage orders={orders} />
        )}
      </div>

      {!booking && tab !== "confirm" && (
        <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 420, background: "#fff", borderTop: "1px solid #f0e8f8", display: "flex" }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)} style={{ flex: 1, padding: "10px 0 12px", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 24 }}>{n.icon}</span>
              <span style={{ fontSize: 11, fontWeight: tab === n.id ? 800 : 400, color: tab === n.id ? C.purple : C.gray }}>{n.label}</span>
              {tab === n.id && <div style={{ width: 24, height: 3, borderRadius: 99, background: C.purple, marginTop: 1 }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
