require("dotenv").config();
const express = require("express"), crypto = require("crypto"), path = require("path");
const { MongoClient } = require("mongodb"), Razorpay = require("razorpay");

const { MONGODB_URI, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, ADMIN_PASSWORD, PORT = 3000 } = process.env;
const FEE_PER_HEAD = 150, MAX_HEADS = 20;
if (!MONGODB_URI || !RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !ADMIN_PASSWORD) { console.error("Missing values in .env"); process.exit(1); }

const rzp = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
const client = new MongoClient(MONGODB_URI);
let col;
const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const EVENTS = ["Dancing","Singing","Beatboxing","Mimicry (Acting)","Standup","Instrument","Poetry","Drama (Skit)","Storytelling","Magic Tricks"];
const s = (v, n = 200) => String(v ?? "").trim().slice(0, n);

// 1) Validate, create Razorpay order (amount computed ON THE SERVER), save as "pending"
app.post("/api/order", async (req, res) => {
  try {
    const b = req.body, members = Math.floor(Number(b.members));
    const events = Array.isArray(b.events) ? b.events.filter(e => EVENTS.includes(e)) : [];
    if (!s(b.name) || !s(b.college) || !s(b.year) || !/^[6-9]\d{9}$/.test(s(b.phone)) || !/^\S+@\S+\.\S+$/.test(s(b.email)) || !events.length || !(members >= 1 && members <= MAX_HEADS))
      return res.status(400).json({ error: "Please check the form fields." });
    const amount = FEE_PER_HEAD * members * 100; // paise
    const regId = "TLN26-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    const order = await rzp.orders.create({ amount, currency: "INR", receipt: regId, notes: { name: s(b.name), phone: s(b.phone) } });
    await col.insertOne({ regId, name: s(b.name), phone: s(b.phone), email: s(b.email), college: s(b.college), year: s(b.year),
      type: s(b.type, 20), members, events, details: s(b.details, 800), amount: amount / 100, status: "pending",
      orderId: order.id, paymentId: null, createdAt: new Date() });
    res.json({ regId, orderId: order.id, amount, keyId: RAZORPAY_KEY_ID });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not start payment. Try again." }); }
});

// 2) Verify Razorpay signature, then mark as paid
app.post("/api/verify", async (req, res) => {
  const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: sig } = req.body || {};
  const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(o + "|" + p).digest("hex");
  if (!o || !p || !sig || expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)))
    return res.status(400).json({ error: "Payment verification failed." });
  const r = await col.findOneAndUpdate({ orderId: o }, { $set: { status: "paid", paymentId: p, paidAt: new Date() } }, { returnDocument: "after" });
  if (!r) return res.status(404).json({ error: "Registration not found." });
  res.json({ ok: true, regId: r.regId, name: r.name });
});

// Admin (HTTP Basic auth: any username, password = ADMIN_PASSWORD)
function admin(req, res, next) {
  const pw = Buffer.from((req.headers.authorization || "").replace("Basic ", ""), "base64").toString().split(":").slice(1).join(":");
  if (pw && pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD))) return next();
  res.set("WWW-Authenticate", 'Basic realm="Talento admin"').status(401).send("Unauthorised");
}
app.get("/admin", admin, (_q, r) => r.sendFile(path.join(__dirname, "admin.html")));
app.get("/api/admin/registrations", admin, async (_q, r) => r.json(await col.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray()));
app.get("/api/admin/export.csv", admin, async (_q, r) => {
  const rows = await col.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  const keys = ["regId","name","phone","email","college","year","type","members","events","details","amount","status","orderId","paymentId","createdAt"];
  const q = v => '"' + String(Array.isArray(v) ? v.join("; ") : v ?? "").replace(/"/g, '""') + '"';
  r.type("text/csv").attachment("talento26-registrations.csv").send([keys.join(","), ...rows.map(x => keys.map(k => q(x[k])).join(","))].join("\n"));
});

client.connect().then(() => {
  col = client.db("talento26").collection("registrations");
  col.createIndex({ orderId: 1 }); col.createIndex({ regId: 1 }, { unique: true });
  app.listen(PORT, () => console.log("Talento ’26 running → http://localhost:" + PORT + "   admin → /admin"));
}).catch(e => { console.error("MongoDB connection failed:", e.message); process.exit(1); });
