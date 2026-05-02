// ============================================================
// 🧵 MOROCCAN EMBROIDERY BOT v2.0
// WhatsApp Cloud API (Meta) - NO TWILIO NEEDED
// Subscription: Basic (50 MAD/month) + Pro (350 MAD/month)
// Free Trial Codes system
// Languages: Arabic / French / English
// Hosted on Railway + PostgreSQL
// ============================================================

const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  WA_TOKEN:            process.env.WA_TOKEN,
  WA_PHONE_ID:         process.env.WA_PHONE_ID,
  WA_VERIFY_TOKEN:     process.env.WA_VERIFY_TOKEN || "embroidery_verify_2024",
  GEMINI_API_KEY:      process.env.GEMINI_API_KEY,
  STRIPE_SECRET_KEY:   process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  CMI_MERCHANT_ID:     process.env.CMI_MERCHANT_ID,
  CASHPLUS_MERCHANT_ID: process.env.CASHPLUS_MERCHANT_ID,
  DATABASE_URL:        process.env.DATABASE_URL,
  ADMIN_SECRET:        process.env.ADMIN_SECRET || "change_me_secret",
  BASE_URL: process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : process.env.BASE_URL || "https://yourapp.up.railway.app",

  PLANS: {
    basic: { price_mad: 50,  price_usd: 5,  files_per_day: 1,    label: { ar: "الأساسي - 50 درهم/شهر",   fr: "Basique - 50 MAD/mois",  en: "Basic - 50 MAD/month"  } },
    pro:   { price_mad: 350, price_usd: 35, files_per_day: 9999, label: { ar: "المحترف - 350 درهم/شهر", fr: "Pro - 350 MAD/mois",      en: "Pro - 350 MAD/month"   } },
    trial: { price_mad: 0,   price_usd: 0,  files_per_day: 3,    label: { ar: "تجريبي مجاني",             fr: "Essai gratuit",           en: "Free trial"            } },
  },
};

// ============================================================
// DATABASE - PostgreSQL (included free in Railway $5 plan)
// ============================================================
const db = new Pool({ connectionString: CONFIG.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone           VARCHAR(20)  PRIMARY KEY,
      language        VARCHAR(5)   DEFAULT 'fr',
      plan            VARCHAR(10)  DEFAULT NULL,
      plan_start      TIMESTAMP    DEFAULT NULL,
      plan_end        TIMESTAMP    DEFAULT NULL,
      files_today     INT          DEFAULT 0,
      files_total     INT          DEFAULT 0,
      last_file_date  DATE         DEFAULT NULL,
      created_at      TIMESTAMP    DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trial_codes (
      code          VARCHAR(20)  PRIMARY KEY,
      plan          VARCHAR(10)  DEFAULT 'trial',
      days          INT          DEFAULT 7,
      max_uses      INT          DEFAULT 1,
      used_count    INT          DEFAULT 0,
      created_by    VARCHAR(20)  DEFAULT 'admin',
      created_at    TIMESTAMP    DEFAULT NOW(),
      expires_at    TIMESTAMP    DEFAULT NOW() + INTERVAL '30 days',
      active        BOOLEAN      DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS code_uses (
      id      SERIAL      PRIMARY KEY,
      code    VARCHAR(20),
      phone   VARCHAR(20),
      used_at TIMESTAMP   DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id          SERIAL      PRIMARY KEY,
      phone       VARCHAR(20),
      plan        VARCHAR(10),
      amount_mad  INT,
      method      VARCHAR(20),
      status      VARCHAR(20) DEFAULT 'pending',
      reference   VARCHAR(100),
      created_at  TIMESTAMP   DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversions (
      id           SERIAL      PRIMARY KEY,
      phone        VARCHAR(20),
      plan         VARCHAR(10),
      stitch_count INT,
      created_at   TIMESTAMP   DEFAULT NOW()
    );
  `);
  console.log("✅ Database ready");
}

// ============================================================
// DB HELPERS
// ============================================================
async function getUser(phone) {
  const res = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
  if (res.rows.length === 0) {
    await db.query("INSERT INTO users (phone) VALUES ($1)", [phone]);
    return { phone, language: "fr", plan: null, files_today: 0, files_total: 0 };
  }
  return res.rows[0];
}

async function updateUser(phone, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`UPDATE users SET ${set} WHERE phone = $1`, [phone, ...values]);
}

async function isSubActive(user) {
  if (!user.plan || !user.plan_end) return false;
  return new Date(user.plan_end) > new Date();
}

async function canConvert(user) {
  if (!await isSubActive(user)) return { ok: false, reason: "no_sub" };
  const today = new Date().toISOString().split("T")[0];
  const lastDate = user.last_file_date
    ? new Date(user.last_file_date).toISOString().split("T")[0]
    : null;
  if (lastDate !== today) {
    await updateUser(user.phone, { files_today: 0 });
    user.files_today = 0;
  }
  const plan = CONFIG.PLANS[user.plan];
  if (!plan) return { ok: false, reason: "no_sub" };
  if (user.files_today >= plan.files_per_day) return { ok: false, reason: "limit" };
  return { ok: true };
}

async function recordConversion(phone, plan, stitchCount = 0) {
  const today = new Date().toISOString().split("T")[0];
  await db.query(
    `UPDATE users SET files_today = files_today + 1, files_total = files_total + 1, last_file_date = $2 WHERE phone = $1`,
    [phone, today]
  );
  await db.query(
    "INSERT INTO conversions (phone, plan, stitch_count) VALUES ($1, $2, $3)",
    [phone, plan, stitchCount]
  );
}

async function activatePlan(phone, plan, months = 1) {
  const end = new Date();
  end.setMonth(end.getMonth() + months);
  await updateUser(phone, { plan, plan_start: new Date(), plan_end: end, files_today: 0 });
}

// ============================================================
// TRIAL CODE HELPERS
// ============================================================
function genCode(prefix = "EMB") {
  return `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

async function createCode({ plan = "trial", days = 7, maxUses = 1, prefix = "EMB" } = {}) {
  const code = genCode(prefix);
  await db.query(
    `INSERT INTO trial_codes (code, plan, days, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($3 || ' days')::INTERVAL)`,
    [code, plan, days, maxUses]
  );
  return code;
}

async function redeemCode(code, phone) {
  const already = await db.query("SELECT id FROM code_uses WHERE code = $1 AND phone = $2", [code, phone]);
  if (already.rows.length > 0) return { ok: false, reason: "already_used" };

  const row = await db.query(
    `SELECT * FROM trial_codes WHERE code = $1 AND active = TRUE AND used_count < max_uses AND expires_at > NOW()`,
    [code.toUpperCase()]
  );
  if (!row.rows.length) return { ok: false, reason: "invalid" };

  const c = row.rows[0];
  const end = new Date();
  end.setDate(end.getDate() + c.days);
  await updateUser(phone, { plan: c.plan, plan_start: new Date(), plan_end: end, files_today: 0 });
  await db.query("INSERT INTO code_uses (code, phone) VALUES ($1, $2)", [code, phone]);
  await db.query("UPDATE trial_codes SET used_count = used_count + 1 WHERE code = $1", [code]);
  return { ok: true, days: c.days, plan: c.plan };
}

// ============================================================
// IN-MEMORY SESSION (conversation flow only)
// ============================================================
const sessions = {};
function session(phone) {
  if (!sessions[phone]) sessions[phone] = { step: "start", mediaId: null, selectedPlan: null, paymentCode: null, orderId: null };
  return sessions[phone];
}

// ============================================================
// MULTILINGUAL MESSAGES
// ============================================================
const MSG = {
  welcome: {
    ar: `🧵 *أهلاً في بوت التطريز المغربي!*\nحوّل أي صورة إلى ملف DST/PES جاهز للآلة.\n\nاختر لغتك:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
    fr: `🧵 *Bienvenue sur le Bot Broderie Maroc!*\nConvertissez n'importe quelle image en fichier DST/PES.\n\nChoisissez votre langue:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
    en: `🧵 *Welcome to Morocco Embroidery Bot!*\nConvert any image into a machine-ready DST/PES file.\n\nChoose your language:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
  },
  menu: {
    ar: `📋 *القائمة الرئيسية*\n\n1️⃣ تحويل صورة 🖼️\n2️⃣ اشتراكي 📊\n3️⃣ الخطط والأسعار 💎\n4️⃣ كود تجريبي 🎟️\n5️⃣ مساعدة ❓`,
    fr: `📋 *Menu principal*\n\n1️⃣ Convertir une image 🖼️\n2️⃣ Mon abonnement 📊\n3️⃣ Plans & tarifs 💎\n4️⃣ Code d'essai 🎟️\n5️⃣ Aide ❓`,
    en: `📋 *Main Menu*\n\n1️⃣ Convert image 🖼️\n2️⃣ My subscription 📊\n3️⃣ Plans & pricing 💎\n4️⃣ Trial code 🎟️\n5️⃣ Help ❓`,
  },
  plans: {
    ar: `💎 *خطط الاشتراك*\n\n━━━━━━━━━━\n🟢 *الأساسي - 50 درهم/شهر*\n• ملف واحد يومياً\n• DST + PES + JEF\n• دعم واتساب\n\n━━━━━━━━━━\n🔵 *المحترف - 350 درهم/شهر*\n• ملفات غير محدودة\n• معالجة أسرع\n• دعم 24/7\n• تحليل AI متقدم\n━━━━━━━━━━\n\n1️⃣ الأساسي (50 درهم)\n2️⃣ المحترف (350 درهم)\n3️⃣ لدي كود تجريبي\n0️⃣ رجوع`,
    fr: `💎 *Plans d'abonnement*\n\n━━━━━━━━━━\n🟢 *Basique - 50 MAD/mois*\n• 1 fichier par jour\n• DST + PES + JEF\n• Support WhatsApp\n\n━━━━━━━━━━\n🔵 *Pro - 350 MAD/mois*\n• Fichiers illimités\n• Traitement prioritaire\n• Support 24/7\n• Analyse AI avancée\n━━━━━━━━━━\n\n1️⃣ Basique (50 MAD)\n2️⃣ Pro (350 MAD)\n3️⃣ J'ai un code d'essai\n0️⃣ Retour`,
    en: `💎 *Subscription Plans*\n\n━━━━━━━━━━\n🟢 *Basic - 50 MAD/month*\n• 1 file per day\n• DST + PES + JEF\n• WhatsApp support\n\n━━━━━━━━━━\n🔵 *Pro - 350 MAD/month*\n• Unlimited files\n• Priority processing\n• 24/7 support\n• Advanced AI analysis\n━━━━━━━━━━\n\n1️⃣ Basic (50 MAD)\n2️⃣ Pro (350 MAD)\n3️⃣ I have a trial code\n0️⃣ Back`,
  },
  askCode: {
    ar: "🎟️ أرسل كودك التجريبي:",
    fr: "🎟️ Envoyez votre code d'essai:",
    en: "🎟️ Send your trial code:",
  },
  codeOk: {
    ar: (d, p) => `✅ *تم تفعيل الكود!*\n🎁 الخطة: ${p === "pro" ? "المحترف 🔵" : p === "basic" ? "الأساسي 🟢" : "تجريبي 🎁"}\n📅 المدة: ${d} يوم\n\nأرسل صورتك الآن! 🧵`,
    fr: (d, p) => `✅ *Code activé!*\n🎁 Plan: ${p === "pro" ? "Pro 🔵" : p === "basic" ? "Basique 🟢" : "Essai 🎁"}\n📅 Durée: ${d} jours\n\nEnvoyez votre image! 🧵`,
    en: (d, p) => `✅ *Code activated!*\n🎁 Plan: ${p === "pro" ? "Pro 🔵" : p === "basic" ? "Basic 🟢" : "Trial 🎁"}\n📅 Duration: ${d} days\n\nSend your image now! 🧵`,
  },
  codeBad:      { ar: "❌ الكود غير صحيح أو منتهي الصلاحية.",         fr: "❌ Code invalide ou expiré.",                    en: "❌ Invalid or expired code."                   },
  codeUsed:     { ar: "⚠️ لقد استخدمت هذا الكود من قبل.",             fr: "⚠️ Vous avez déjà utilisé ce code.",            en: "⚠️ You already used this code."               },
  askImage:     { ar: "🖼️ أرسل الصورة التي تريد تطريزها (PNG/JPG)",  fr: "🖼️ Envoyez l'image à broder (PNG/JPG)",         en: "🖼️ Send the image you want to embroider (PNG/JPG)" },
  noSub:        { ar: "⚠️ لا يوجد اشتراك نشط\n\n1️⃣ الخطط والأسعار\n2️⃣ كود تجريبي", fr: "⚠️ Pas d'abonnement actif\n\n1️⃣ Voir les plans\n2️⃣ Code d'essai", en: "⚠️ No active subscription\n\n1️⃣ See plans\n2️⃣ Trial code" },
  limitReached: { ar: "⛔ *وصلت للحد اليومي*\nالأساسي: ملف واحد يومياً\n\nأرسل *ترقية* للخطة المحترفة (350 درهم/شهر)", fr: "⛔ *Limite journalière atteinte*\nBasique: 1 fichier/jour\n\nEnvoyez *upgrade* pour le plan Pro (350 MAD/mois)", en: "⛔ *Daily limit reached*\nBasic: 1 file/day\n\nSend *upgrade* for Pro plan (350 MAD/month)" },
  processing:   { ar: "⏳ *جاري المعالجة...*\nيتم تحليل تصميمك بالذكاء الاصطناعي 🎨", fr: "⏳ *Traitement en cours...*\nAnalyse IA de votre design 🎨", en: "⏳ *Processing...*\nAI analyzing your design 🎨" },
  done:         { ar: "✅ *تم! إليك ملفاتك* 🎉",                       fr: "✅ *Terminé! Vos fichiers* 🎉",                  en: "✅ *Done! Your files* 🎉"                      },
  error:        { ar: "❌ حدث خطأ. حاول مجدداً أو أرسل *مساعدة*",     fr: "❌ Erreur. Réessayez ou envoyez *aide*",         en: "❌ Error. Try again or send *help*"            },
  help: {
    ar: `❓ *المساعدة*\n\n🔹 أرسل صورة لتحويلها لملف تطريز\n🔹 الأساسي: ملف/يوم — 50 درهم/شهر\n🔹 المحترف: غير محدود — 350 درهم/شهر\n🔹 كود تجريبي: تواصل مع الإدارة\n\n0️⃣ القائمة الرئيسية`,
    fr: `❓ *Aide*\n\n🔹 Envoyez une image pour la convertir\n🔹 Basique: 1 fichier/jour — 50 MAD/mois\n🔹 Pro: illimité — 350 MAD/mois\n🔹 Code d'essai: contactez l'admin\n\n0️⃣ Menu principal`,
    en: `❓ *Help*\n\n🔹 Send an image to convert it\n🔹 Basic: 1 file/day — 50 MAD/month\n🔹 Pro: unlimited — 350 MAD/month\n🔹 Trial code: contact admin\n\n0️⃣ Main menu`,
  },
  payOpts: {
    ar: (label) => `💳 *طريقة الدفع*\nالخطة: ${label}\n\n1️⃣ CashPlus (نقداً)\n2️⃣ CMI (بطاقة بنكية)\n3️⃣ تحويل بنكي\n4️⃣ Stripe (Visa/Mastercard)\n0️⃣ رجوع`,
    fr: (label) => `💳 *Mode de paiement*\nPlan: ${label}\n\n1️⃣ CashPlus (Espèces)\n2️⃣ CMI (Carte bancaire)\n3️⃣ Virement bancaire\n4️⃣ Stripe (Visa/Mastercard)\n0️⃣ Retour`,
    en: (label) => `💳 *Payment method*\nPlan: ${label}\n\n1️⃣ CashPlus (Cash)\n2️⃣ CMI (Bank card)\n3️⃣ Bank Transfer\n4️⃣ Stripe (Visa/Mastercard)\n0️⃣ Back`,
  },
  myPlan: {
    ar: (u, d) => `📊 *اشتراكي*\n\n📦 الخطة: ${u.plan === "pro" ? "المحترف 🔵" : u.plan === "basic" ? "الأساسي 🟢" : u.plan === "trial" ? "تجريبي 🎁" : "لا يوجد"}\n📅 ينتهي خلال: ${d} يوم\n🧵 ملفات اليوم: ${u.files_today || 0}\n📁 الإجمالي: ${u.files_total || 0}`,
    fr: (u, d) => `📊 *Mon abonnement*\n\n📦 Plan: ${u.plan === "pro" ? "Pro 🔵" : u.plan === "basic" ? "Basique 🟢" : u.plan === "trial" ? "Essai 🎁" : "Aucun"}\n📅 Expire dans: ${d} jours\n🧵 Fichiers aujourd'hui: ${u.files_today || 0}\n📁 Total: ${u.files_total || 0}`,
    en: (u, d) => `📊 *My Subscription*\n\n📦 Plan: ${u.plan === "pro" ? "Pro 🔵" : u.plan === "basic" ? "Basic 🟢" : u.plan === "trial" ? "Trial 🎁" : "None"}\n📅 Expires in: ${d} days\n🧵 Files today: ${u.files_today || 0}\n📁 Total: ${u.files_total || 0}`,
  },
  activated: {
    ar: (label) => `✅ *تمت الاشتراك!*\nخطتك *${label}* مفعّلة الآن 🎉`,
    fr: (label) => `✅ *Abonnement activé!*\nVotre plan *${label}* est actif 🎉`,
    en: (label) => `✅ *Subscription activated!*\nYour *${label}* plan is now active 🎉`,
  },
};

function m(key, lang, ...args) {
  const l = ["ar","fr","en"].includes(lang) ? lang : "fr";
  const v = MSG[key]?.[l] ?? MSG[key]?.fr ?? MSG[key]?.en;
  return typeof v === "function" ? v(...args) : (v || "");
}

// ============================================================
// WHATSAPP API
// ============================================================
async function sendText(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WA_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } }
    );
  } catch (e) { console.error("WA sendText:", e.response?.data || e.message); }
}

async function sendDoc(to, url, filename, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${CONFIG.WA_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "document", document: { link: url, filename, caption } },
      { headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } }
    );
  } catch (e) { console.error("WA sendDoc:", e.message); }
}

async function mediaUrl(id) {
  const r = await axios.get(`https://graph.facebook.com/v19.0/${id}`, { headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } });
  return r.data.url;
}

// ============================================================
// GEMINI
// ============================================================
async function analyze(imgUrl) {
  const r = await axios.get(imgUrl, { responseType: "arraybuffer", headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } });
  const b64 = Buffer.from(r.data).toString("base64");
  const mime = r.headers["content-type"] || "image/jpeg";
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
    { contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: `Analyze for embroidery. Return ONLY JSON: {"complexity":"simple|medium|complex","colors":["#hex"],"width_mm":80,"height_mm":80,"stitch_count":5000,"description":"brief"}` }] }] }
  );
  try { return JSON.parse(res.data.candidates[0].content.parts[0].text.replace(/```json|```/g,"").trim()); }
  catch { return { complexity:"medium", colors:["#000000"], width_mm:80, height_mm:80, stitch_count:5000 }; }
}

async function generateFile(imgUrl, analysis, phone) {
  const r = await axios.post(`${CONFIG.BASE_URL}/generate-embroidery`, { image_url: imgUrl, analysis, phone }, { timeout: 60000 });
  return r.data;
}

// ============================================================
// PAYMENT FLOWS
// ============================================================
async function payCashplus(phone, plan, lang) {
  const code = Math.floor(100000 + Math.random() * 900000);
  const amt = CONFIG.PLANS[plan].price_mad;
  session(phone).paymentCode = code;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cashplus',$4)", [phone, plan, amt, String(code)]);
  const t = { ar: `💵 *CashPlus*\n\n💰 المبلغ: *${amt} درهم*\n🔑 الكود: *${code}*\n\nادفع في أقرب نقطة CashPlus ثم أرسل:\n✅ *تم ${code}*`, fr: `💵 *CashPlus*\n\n💰 Montant: *${amt} MAD*\n🔑 Code: *${code}*\n\nPayez au point CashPlus puis envoyez:\n✅ *payé ${code}*`, en: `💵 *CashPlus*\n\n💰 Amount: *${amt} MAD*\n🔑 Code: *${code}*\n\nPay at nearest CashPlus then send:\n✅ *paid ${code}*` };
  await sendText(phone, t[lang]);
}

async function payCMI(phone, plan, lang) {
  const oid = `EMB-${Date.now()}-${phone.slice(-4)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  session(phone).orderId = oid;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cmi',$4)", [phone, plan, amt, oid]);
  const url = `https://payment.cmi.co.ma/fim/est3Dgate?clientid=${CONFIG.CMI_MERCHANT_ID}&amount=${amt}.00&currency=504&oid=${oid}&okUrl=${CONFIG.BASE_URL}/payment/cmi/success&callbackUrl=${CONFIG.BASE_URL}/payment/cmi/callback&lang=ar`;
  const t = { ar: `💳 *CMI*\n\n💰 المبلغ: *${amt} درهم*\n\nانقر للدفع:\n${url}\n\n✅ تُفعَّل خطتك تلقائياً`, fr: `💳 *CMI*\n\n💰 Montant: *${amt} MAD*\n\nCliquez pour payer:\n${url}\n\n✅ Plan activé automatiquement`, en: `💳 *CMI*\n\n💰 Amount: *${amt} MAD*\n\nClick to pay:\n${url}\n\n✅ Plan activated automatically` };
  await sendText(phone, t[lang]);
}

async function payTransfer(phone, plan, lang) {
  const ref = `EMB${Date.now().toString().slice(-8)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  session(phone).transferRef = ref;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'transfer',$4)", [phone, plan, amt, ref]);
  const t = { ar: `🏦 *تحويل بنكي*\n\n🏛️ Attijariwafa Bank\nRIB: *007 780 0001234567890112*\n💰 المبلغ: *${amt} درهم*\n📝 المرجع: *${ref}*\n\nأرسل صورة الإيصال بعد التحويل`, fr: `🏦 *Virement bancaire*\n\n🏛️ Attijariwafa Bank\nRIB: *007 780 0001234567890112*\n💰 Montant: *${amt} MAD*\n📝 Référence: *${ref}*\n\nEnvoyez photo du reçu`, en: `🏦 *Bank Transfer*\n\n🏛️ Attijariwafa Bank\nRIB: *007 780 0001234567890112*\n💰 Amount: *${amt} MAD*\n📝 Reference: *${ref}*\n\nSend receipt photo after transfer` };
  await sendText(phone, t[lang]);
}

async function payStripe(phone, plan, lang) {
  const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
  const amt = CONFIG.PLANS[plan].price_usd * 100;
  const s = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{ price_data: { currency: "usd", product_data: { name: `Embroidery Bot - ${CONFIG.PLANS[plan].label.en}` }, unit_amount: amt }, quantity: 1 }],
    mode: "payment",
    success_url: `${CONFIG.BASE_URL}/payment/stripe/success?phone=${phone}&plan=${plan}`,
    cancel_url: `${CONFIG.BASE_URL}/payment/stripe/cancel`,
    metadata: { phone, plan },
  });
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'stripe',$4)", [phone, plan, CONFIG.PLANS[plan].price_mad, s.id]);
  const t = { ar: `💳 *Stripe*\n\nانقر للدفع:\n${s.url}\n\n✅ تُفعَّل خطتك فوراً`, fr: `💳 *Stripe*\n\nCliquez pour payer:\n${s.url}\n\n✅ Plan activé immédiatement`, en: `💳 *Stripe*\n\nClick to pay:\n${s.url}\n\n✅ Plan activated instantly` };
  await sendText(phone, t[lang]);
}

// ============================================================
// PROCESS & DELIVER FILE
// ============================================================
async function processAndDeliver(phone, user) {
  const lang = user.language || "fr";
  const sess = session(phone);
  await sendText(phone, m("processing", lang));
  try {
    const url = await mediaUrl(sess.mediaId);
    const analysis = await analyze(url);
    const files = await generateFile(url, analysis, phone);
    await recordConversion(phone, user.plan, files.stitch_count || 0);

    await sendText(phone, m("done", lang));
    await sendDoc(phone, files.dst_url, "embroidery.dst", "📁 DST — Tajima / Universal");
    await sendDoc(phone, files.pes_url, "embroidery.pes", "📁 PES — Brother / Janome");

    const summary = {
      ar: `📊 *تفاصيل التطريز:*\n🧵 الغرز: ${(files.stitch_count||5000).toLocaleString()}\n📐 الحجم: ${analysis.width_mm}×${analysis.height_mm}mm\n🎨 الألوان: ${analysis.colors?.length||1}\n⚡ التعقيد: ${analysis.complexity}`,
      fr: `📊 *Détails broderie:*\n🧵 Points: ${(files.stitch_count||5000).toLocaleString()}\n📐 Taille: ${analysis.width_mm}×${analysis.height_mm}mm\n🎨 Couleurs: ${analysis.colors?.length||1}\n⚡ Complexité: ${analysis.complexity}`,
      en: `📊 *Embroidery details:*\n🧵 Stitches: ${(files.stitch_count||5000).toLocaleString()}\n📐 Size: ${analysis.width_mm}×${analysis.height_mm}mm\n🎨 Colors: ${analysis.colors?.length||1}\n⚡ Complexity: ${analysis.complexity}`,
    };
    await sendText(phone, summary[lang]);
    sess.step = "menu";
    await sendText(phone, m("menu", lang));
  } catch (e) {
    console.error("Deliver error:", e.message);
    await sendText(phone, m("error", lang));
  }
}

// ============================================================
// HANDLE INCOMING MESSAGE
// ============================================================
async function handle(phone, type, body, mediaId) {
  const user = await getUser(phone);
  const lang = user.language || "fr";
  const sess = session(phone);
  const t = body?.trim() || "";
  const tl = t.toLowerCase();

  // Global shortcuts
  if (["0","menu","قائمة","retour","back"].includes(tl)) { sess.step = "menu"; return sendText(phone, m("menu", lang)); }
  if (["help","aide","مساعدة"].includes(tl)) return sendText(phone, m("help", lang));
  if (["upgrade","ترقية"].includes(tl)) { sess.step = "plans"; return sendText(phone, m("plans", lang)); }

  switch (sess.step) {

    case "start":
      await sendText(phone, m("welcome", "fr"));
      sess.step = "choose_language";
      break;

    case "choose_language":
      if (["1","2","3"].includes(t)) {
        const lmap = { "1":"ar","2":"fr","3":"en" };
        await updateUser(phone, { language: lmap[t] });
        sess.step = "menu";
        return sendText(phone, m("menu", lmap[t]));
      }
      await sendText(phone, m("welcome", "fr"));
      break;

    case "menu":
      if (t === "1") {
        const check = await canConvert(user);
        if (!check.ok) {
          if (check.reason === "limit") return sendText(phone, m("limitReached", lang));
          sess.step = "no_sub";
          return sendText(phone, m("noSub", lang));
        }
        sess.step = "waiting_image";
        return sendText(phone, m("askImage", lang));
      }
      if (t === "2") {
        const active = await isSubActive(user);
        if (!active) { sess.step = "no_sub"; return sendText(phone, m("noSub", lang)); }
        const days = Math.ceil((new Date(user.plan_end) - new Date()) / 86400000);
        return sendText(phone, m("myPlan", lang, user, days));
      }
      if (t === "3") { sess.step = "plans"; return sendText(phone, m("plans", lang)); }
      if (t === "4") { sess.step = "enter_code"; return sendText(phone, m("askCode", lang)); }
      if (t === "5") return sendText(phone, m("help", lang));
      await sendText(phone, m("menu", lang));
      break;

    case "no_sub":
      if (t === "1") { sess.step = "plans"; return sendText(phone, m("plans", lang)); }
      if (t === "2") { sess.step = "enter_code"; return sendText(phone, m("askCode", lang)); }
      await sendText(phone, m("noSub", lang));
      break;

    case "enter_code": {
      const result = await redeemCode(t, phone);
      if (result.ok) {
        sess.step = "menu";
        await sendText(phone, m("codeOk", lang, result.days, result.plan));
        return sendText(phone, m("menu", lang));
      }
      if (result.reason === "already_used") return sendText(phone, m("codeUsed", lang));
      return sendText(phone, m("codeBad", lang));
    }

    case "plans":
      if (t === "1") { sess.selectedPlan = "basic"; sess.step = "choose_payment"; return sendText(phone, m("payOpts", lang, CONFIG.PLANS.basic.label[lang])); }
      if (t === "2") { sess.selectedPlan = "pro";   sess.step = "choose_payment"; return sendText(phone, m("payOpts", lang, CONFIG.PLANS.pro.label[lang])); }
      if (t === "3") { sess.step = "enter_code"; return sendText(phone, m("askCode", lang)); }
      await sendText(phone, m("plans", lang));
      break;

    case "choose_payment": {
      const pl = sess.selectedPlan;
      if (t === "1") { sess.step = "waiting_cashplus"; await payCashplus(phone, pl, lang); }
      else if (t === "2") { sess.step = "waiting_cmi";      await payCMI(phone, pl, lang); }
      else if (t === "3") { sess.step = "waiting_transfer"; await payTransfer(phone, pl, lang); }
      else if (t === "4") { sess.step = "waiting_stripe";   await payStripe(phone, pl, lang); }
      else await sendText(phone, m("payOpts", lang, CONFIG.PLANS[pl].label[lang]));
      break;
    }

    case "waiting_cashplus": {
      const code = sess.paymentCode?.toString();
      const ok = t.includes(code) && (t.includes("تم") || t.includes("paid") || t.includes("payé"));
      if (ok) {
        await activatePlan(phone, sess.selectedPlan);
        await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='cashplus' AND status='pending'", [phone]);
        sess.step = "menu";
        await sendText(phone, m("activated", lang, CONFIG.PLANS[sess.selectedPlan].label[lang]));
        return sendText(phone, m("menu", lang));
      }
      const wait = { ar: `⏳ في انتظار دفعك...\nأرسل: *تم ${sess.paymentCode}*`, fr: `⏳ En attente...\nEnvoyez: *payé ${sess.paymentCode}*`, en: `⏳ Waiting...\nSend: *paid ${sess.paymentCode}*` };
      await sendText(phone, wait[lang]);
      break;
    }

    case "waiting_transfer":
      if (type === "image" || type === "document") {
        await activatePlan(phone, sess.selectedPlan);
        await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='transfer' AND status='pending'", [phone]);
        sess.step = "menu";
        await sendText(phone, m("activated", lang, CONFIG.PLANS[sess.selectedPlan].label[lang]));
        return sendText(phone, m("menu", lang));
      }
      break;

    case "waiting_image":
      if (type === "image" || type === "document") {
        sess.mediaId = mediaId;
        const fresh = await getUser(phone);
        return processAndDeliver(phone, fresh);
      }
      await sendText(phone, m("askImage", lang));
      break;

    default:
      sess.step = "menu";
      await sendText(phone, m("menu", lang));
  }
}

// ============================================================
// WEBHOOK
// ============================================================
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === CONFIG.WA_VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    await handle(msg.from, msg.type, msg.text?.body || "", msg.image?.id || msg.document?.id);
  } catch (e) { console.error("Webhook:", e.message); }
});

// ============================================================
// PAYMENT CALLBACKS
// ============================================================
app.post("/payment/stripe/callback", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], CONFIG.STRIPE_WEBHOOK_SECRET);
    if (event.type === "checkout.session.completed") {
      const { phone, plan } = event.data.object.metadata;
      await activatePlan(phone, plan);
      await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='stripe' AND status='pending'", [phone]);
      const user = await getUser(phone);
      const lang = user.language || "fr";
      session(phone).step = "menu";
      await sendText(phone, m("activated", lang, CONFIG.PLANS[plan].label[lang]));
      await sendText(phone, m("menu", lang));
    }
    res.json({ received: true });
  } catch (e) { res.status(400).send(e.message); }
});

app.post("/payment/cmi/callback", async (req, res) => {
  const { oid, Response } = req.body;
  if (Response === "Approved") {
    const r = await db.query("SELECT * FROM payments WHERE reference=$1", [oid]);
    if (r.rows.length) {
      const { phone, plan } = r.rows[0];
      await activatePlan(phone, plan);
      await db.query("UPDATE payments SET status='confirmed' WHERE reference=$1", [oid]);
      const user = await getUser(phone);
      const lang = user.language || "fr";
      session(phone).step = "menu";
      await sendText(phone, m("activated", lang, CONFIG.PLANS[plan].label[lang]));
      await sendText(phone, m("menu", lang));
    }
  }
  res.send("ACTION=POSTAUTH");
});

app.get("/payment/stripe/success", (_, res) =>
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4"><h1 style="color:#16a34a">✅ Payment Successful!</h1><p>Check WhatsApp — your subscription is now active! 🧵</p></body></html>`)
);

// ============================================================
// ADMIN API - Trial Codes & Stats
// ============================================================
function adminAuth(req, res) {
  const secret = req.body?.secret || req.query?.secret;
  if (secret !== CONFIG.ADMIN_SECRET) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

// Generate 1 code
app.post("/admin/code", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { plan = "trial", days = 7, maxUses = 1, prefix = "EMB" } = req.body;
  const code = await createCode({ plan, days, maxUses, prefix });
  res.json({ code, plan, days, maxUses });
});

// Generate bulk codes (for campaigns)
app.post("/admin/codes/bulk", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { count = 10, plan = "trial", days = 7, maxUses = 1, prefix = "EMB" } = req.body;
  const codes = [];
  for (let i = 0; i < count; i++) codes.push(await createCode({ plan, days, maxUses, prefix }));
  res.json({ codes, count: codes.length });
});

// Send code directly to a user via WhatsApp
app.post("/admin/send-code", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, plan = "trial", days = 7 } = req.body;
  const code = await createCode({ plan, days, maxUses: 1 });
  const user = await getUser(phone);
  const lang = user.language || "fr";
  const t = {
    ar: `🎁 *هدية لك من بوت التطريز!*\n\nكودك التجريبي:\n🎟️ *${code}*\n\n✨ ${days} أيام مجانية — ${plan === "pro" ? "خطة المحترف 🔵" : "خطة الأساسي 🟢"}\n\nأرسل الكود للبوت لتفعيله!`,
    fr: `🎁 *Un cadeau du Bot Broderie!*\n\nVotre code d'essai:\n🎟️ *${code}*\n\n✨ ${days} jours gratuits — Plan ${plan === "pro" ? "Pro 🔵" : "Basique 🟢"}\n\nEnvoyez le code au bot pour l'activer!`,
    en: `🎁 *A gift from Embroidery Bot!*\n\nYour trial code:\n🎟️ *${code}*\n\n✨ ${days} free days — ${plan === "pro" ? "Pro 🔵" : "Basic 🟢"} plan\n\nSend the code to the bot to activate!`,
  };
  await sendText(phone, t[lang]);
  res.json({ success: true, code, phone });
});

// List all codes
app.get("/admin/codes", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const r = await db.query("SELECT * FROM trial_codes ORDER BY created_at DESC LIMIT 100");
  res.json(r.rows);
});

// Dashboard stats
app.get("/admin/stats", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const [users, revenue, conversions, codes] = await Promise.all([
    db.query(`SELECT
      COUNT(*) total,
      COUNT(CASE WHEN plan='basic' AND plan_end > NOW() THEN 1 END) basic,
      COUNT(CASE WHEN plan='pro'   AND plan_end > NOW() THEN 1 END) pro,
      COUNT(CASE WHEN plan='trial' AND plan_end > NOW() THEN 1 END) trial
      FROM users`),
    db.query("SELECT SUM(amount_mad) total_mad, COUNT(*) total FROM payments WHERE status='confirmed'"),
    db.query("SELECT COUNT(*) total, SUM(stitch_count) total_stitches FROM conversions"),
    db.query("SELECT COUNT(*) total, SUM(used_count) used FROM trial_codes WHERE active=TRUE"),
  ]);
  res.json({
    users: users.rows[0],
    revenue: revenue.rows[0],
    conversions: conversions.rows[0],
    trial_codes: codes.rows[0],
  });
});

app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime(), version: "2.0" }));

// ============================================================
// BOOT
// ============================================================
const PORT = process.env.PORT || 3000;
(async () => {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🧵 Embroidery Bot v2.0 on port ${PORT}`);
    console.log(`📡 Webhook: ${CONFIG.BASE_URL}/webhook`);
    console.log(`📊 Stats: ${CONFIG.BASE_URL}/admin/stats?secret=YOUR_SECRET`);
  });
})();

app.get('/', (req, res) => res.sendFile('/app/index.html'));
