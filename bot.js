// ============================================================
// 🧵 MOROCCAN EMBROIDERY BOT v3.0
// whatsapp-web.js (no Meta approval needed!)
// Subscription: Basic (50 MAD) + Pro (350 MAD)
// Trial codes system
// Languages: Arabic / French / English
// Hosted on Railway + PostgreSQL
// ============================================================

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
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
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  CMI_MERCHANT_ID: process.env.CMI_MERCHANT_ID,
  CASHPLUS_MERCHANT_ID: process.env.CASHPLUS_MERCHANT_ID,
  DATABASE_URL: process.env.DATABASE_URL,
  ADMIN_SECRET: process.env.ADMIN_SECRET || "change_me_secret",
  BASE_URL: process.env.BASE_URL || "https://stichai.pro",
  ADMIN_PHONE: process.env.ADMIN_PHONE || "212675823517",

  PLANS: {
    basic: { price_mad: 50,  price_usd: 5,  files_per_day: 1,    label: { ar: "الأساسي - 50 درهم/شهر",   fr: "Basique - 50 MAD/mois",  en: "Basic - 50 MAD/month"  } },
    pro:   { price_mad: 350, price_usd: 35, files_per_day: 9999, label: { ar: "المحترف - 350 درهم/شهر", fr: "Pro - 350 MAD/mois",      en: "Pro - 350 MAD/month"   } },
    trial: { price_mad: 0,   price_usd: 0,  files_per_day: 3,    label: { ar: "تجريبي مجاني",             fr: "Essai gratuit",           en: "Free trial"            } },
  },

  GEMINI_MODELS: {
    lite:  "gemini-2.5-flash-lite-preview-06-17",
    flash: "gemini-2.5-flash",
    pro:   "gemini-2.5-pro",
  },
};

// ============================================================
// DATABASE
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

async function getUser(phone) {
  const clean = phone.replace(/[@c.us]/g, "");
  const res = await db.query("SELECT * FROM users WHERE phone = $1", [clean]);
  if (!res.rows.length) {
    await db.query("INSERT INTO users (phone) VALUES ($1)", [clean]);
    return { phone: clean, language: "fr", plan: null, files_today: 0, files_total: 0 };
  }
  return res.rows[0];
}

async function updateUser(phone, fields) {
  const clean = phone.replace(/[@c.us]/g, "");
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`UPDATE users SET ${set} WHERE phone = $1`, [clean, ...values]);
}

async function isSubActive(user) {
  if (!user.plan || !user.plan_end) return false;
  return new Date(user.plan_end) > new Date();
}

async function canConvert(user) {
  if (!await isSubActive(user)) return { ok: false, reason: "no_sub" };
  const today = new Date().toISOString().split("T")[0];
  const lastDate = user.last_file_date ? new Date(user.last_file_date).toISOString().split("T")[0] : null;
  if (lastDate !== today) { await updateUser(user.phone, { files_today: 0 }); user.files_today = 0; }
  const plan = CONFIG.PLANS[user.plan];
  if (!plan) return { ok: false, reason: "no_sub" };
  if (user.files_today >= plan.files_per_day) return { ok: false, reason: "limit" };
  return { ok: true };
}

async function activatePlan(phone, plan, months = 1) {
  const end = new Date();
  end.setMonth(end.getMonth() + months);
  await updateUser(phone, { plan, plan_start: new Date(), plan_end: end, files_today: 0 });
}

async function recordConversion(phone, plan, stitchCount = 0) {
  const today = new Date().toISOString().split("T")[0];
  await db.query(`UPDATE users SET files_today = files_today + 1, files_total = files_total + 1, last_file_date = $2 WHERE phone = $1`, [phone.replace(/[@c.us]/g, ""), today]);
  await db.query("INSERT INTO conversions (phone, plan, stitch_count) VALUES ($1, $2, $3)", [phone.replace(/[@c.us]/g, ""), plan, stitchCount]);
}

// ============================================================
// TRIAL CODES
// ============================================================
function genCode(prefix = "EMB") {
  return `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

async function createCode({ plan = "trial", days = 7, maxUses = 1, prefix = "EMB" } = {}) {
  const code = genCode(prefix);
  await db.query(
    `INSERT INTO trial_codes (code, plan, days, max_uses, expires_at) VALUES ($1, $2, $3, $4, NOW() + ($3 || ' days')::INTERVAL)`,
    [code, plan, days, maxUses]
  );
  return code;
}

async function redeemCode(code, phone) {
  const clean = phone.replace(/[@c.us]/g, "");
  const already = await db.query("SELECT id FROM code_uses WHERE code = $1 AND phone = $2", [code, clean]);
  if (already.rows.length) return { ok: false, reason: "already_used" };
  const row = await db.query(
    `SELECT * FROM trial_codes WHERE code = $1 AND active = TRUE AND used_count < max_uses AND expires_at > NOW()`,
    [code.toUpperCase()]
  );
  if (!row.rows.length) return { ok: false, reason: "invalid" };
  const c = row.rows[0];
  const end = new Date();
  end.setDate(end.getDate() + c.days);
  await updateUser(clean, { plan: c.plan, plan_start: new Date(), plan_end: end, files_today: 0 });
  await db.query("INSERT INTO code_uses (code, phone) VALUES ($1, $2)", [code, clean]);
  await db.query("UPDATE trial_codes SET used_count = used_count + 1 WHERE code = $1", [code]);
  return { ok: true, days: c.days, plan: c.plan };
}

// ============================================================
// SESSION
// ============================================================
const sessions = {};
function sess(phone) {
  const clean = phone.replace(/[@c.us]/g, "");
  if (!sessions[clean]) sessions[clean] = { step: "start", mediaData: null, selectedPlan: null, paymentCode: null, orderId: null };
  return sessions[clean];
}

// ============================================================
// MESSAGES
// ============================================================
const MSG = {
  welcome: {
    ar: `🧵 *أهلاً في Stichai - بوت التطريز المغربي!*\nحوّل أي صورة إلى ملف DST/PES جاهز للآلة.\n\nاختر لغتك:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
    fr: `🧵 *Bienvenue sur Stichai - Bot Broderie Maroc!*\nConvertissez n'importe quelle image en fichier DST/PES.\n\nChoisissez votre langue:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
    en: `🧵 *Welcome to Stichai - Morocco Embroidery Bot!*\nConvert any image into a machine-ready DST/PES file.\n\nChoose your language:\n1️⃣ العربية\n2️⃣ Français\n3️⃣ English`,
  },
  menu: {
    ar: `📋 *القائمة الرئيسية*\n\n1️⃣ تحويل صورة 🖼️\n2️⃣ اشتراكي 📊\n3️⃣ الخطط والأسعار 💎\n4️⃣ كود تجريبي 🎟️\n5️⃣ مساعدة ❓`,
    fr: `📋 *Menu principal*\n\n1️⃣ Convertir une image 🖼️\n2️⃣ Mon abonnement 📊\n3️⃣ Plans & tarifs 💎\n4️⃣ Code d'essai 🎟️\n5️⃣ Aide ❓`,
    en: `📋 *Main Menu*\n\n1️⃣ Convert image 🖼️\n2️⃣ My subscription 📊\n3️⃣ Plans & pricing 💎\n4️⃣ Trial code 🎟️\n5️⃣ Help ❓`,
  },
  plans: {
    ar: `💎 *خطط الاشتراك*\n\n━━━━━━━━━━\n🟢 *الأساسي - 50 درهم/شهر*\n• ملف واحد يومياً\n• DST + PES + JEF\n• دعم واتساب\n\n━━━━━━━━━━\n🔵 *المحترف - 350 درهم/شهر*\n• ملفات غير محدودة\n• معالجة أسرع\n• دعم 24/7\n━━━━━━━━━━\n\n1️⃣ الأساسي (50 درهم)\n2️⃣ المحترف (350 درهم)\n3️⃣ لدي كود تجريبي\n0️⃣ رجوع`,
    fr: `💎 *Plans d'abonnement*\n\n━━━━━━━━━━\n🟢 *Basique - 50 MAD/mois*\n• 1 fichier par jour\n• DST + PES + JEF\n• Support WhatsApp\n\n━━━━━━━━━━\n🔵 *Pro - 350 MAD/mois*\n• Fichiers illimités\n• Traitement prioritaire\n• Support 24/7\n━━━━━━━━━━\n\n1️⃣ Basique (50 MAD)\n2️⃣ Pro (350 MAD)\n3️⃣ J'ai un code d'essai\n0️⃣ Retour`,
    en: `💎 *Subscription Plans*\n\n━━━━━━━━━━\n🟢 *Basic - 50 MAD/month*\n• 1 file per day\n• DST + PES + JEF\n• WhatsApp support\n\n━━━━━━━━━━\n🔵 *Pro - 350 MAD/month*\n• Unlimited files\n• Priority processing\n• 24/7 support\n━━━━━━━━━━\n\n1️⃣ Basic (50 MAD)\n2️⃣ Pro (350 MAD)\n3️⃣ I have a trial code\n0️⃣ Back`,
  },
  askCode:      { ar: "🎟️ أرسل كودك التجريبي:",                          fr: "🎟️ Envoyez votre code d'essai:",                  en: "🎟️ Send your trial code:"                      },
  codeOk:       { ar: (d,p) => `✅ *تم تفعيل الكود!*\n🎁 الخطة: ${p==="pro"?"المحترف 🔵":p==="basic"?"الأساسي 🟢":"تجريبي 🎁"}\n📅 المدة: ${d} يوم`, fr: (d,p) => `✅ *Code activé!*\n🎁 Plan: ${p==="pro"?"Pro 🔵":p==="basic"?"Basique 🟢":"Essai 🎁"}\n📅 Durée: ${d} jours`, en: (d,p) => `✅ *Code activated!*\n🎁 Plan: ${p==="pro"?"Pro 🔵":p==="basic"?"Basic 🟢":"Trial 🎁"}\n📅 Duration: ${d} days` },
  codeBad:      { ar: "❌ الكود غير صحيح أو منتهي الصلاحية.",              fr: "❌ Code invalide ou expiré.",                     en: "❌ Invalid or expired code."                    },
  codeUsed:     { ar: "⚠️ لقد استخدمت هذا الكود من قبل.",                 fr: "⚠️ Vous avez déjà utilisé ce code.",             en: "⚠️ You already used this code."                },
  askImage:     { ar: "🖼️ أرسل الصورة التي تريد تطريزها (PNG/JPG)",       fr: "🖼️ Envoyez l'image à broder (PNG/JPG)",          en: "🖼️ Send the image you want to embroider (PNG/JPG)" },
  noSub:        { ar: "⚠️ لا يوجد اشتراك نشط\n\n1️⃣ الخطط والأسعار\n2️⃣ كود تجريبي", fr: "⚠️ Pas d'abonnement actif\n\n1️⃣ Voir les plans\n2️⃣ Code d'essai", en: "⚠️ No active subscription\n\n1️⃣ See plans\n2️⃣ Trial code" },
  limitReached: { ar: "⛔ وصلت للحد اليومي\nأرسل *ترقية* للخطة المحترفة",  fr: "⛔ Limite journalière atteinte\nEnvoyez *upgrade* pour le plan Pro", en: "⛔ Daily limit reached\nSend *upgrade* for Pro plan" },
  processing:   { ar: "⏳ *جاري المعالجة...*\nيتم تحليل تصميمك بالذكاء الاصطناعي 🎨", fr: "⏳ *Traitement en cours...*\nAnalyse IA de votre design 🎨", en: "⏳ *Processing...*\nAI analyzing your design 🎨" },
  done:         { ar: "✅ *تم! إليك ملفاتك* 🎉",                            fr: "✅ *Terminé! Vos fichiers* 🎉",                   en: "✅ *Done! Your files* 🎉"                        },
  error:        { ar: "❌ حدث خطأ. حاول مجدداً أو أرسل *مساعدة*",          fr: "❌ Erreur. Réessayez ou envoyez *aide*",          en: "❌ Error. Try again or send *help*"              },
  help: {
    ar: `❓ *المساعدة*\n\n🔹 أرسل صورة لتحويلها\n🔹 الأساسي: ملف/يوم — 50 درهم/شهر\n🔹 المحترف: غير محدود — 350 درهم/شهر\n🔹 للدعم: ${CONFIG.ADMIN_PHONE}\n\n0️⃣ القائمة`,
    fr: `❓ *Aide*\n\n🔹 Envoyez une image pour la convertir\n🔹 Basique: 1/jour — 50 MAD/mois\n🔹 Pro: illimité — 350 MAD/mois\n🔹 Support: ${CONFIG.ADMIN_PHONE}\n\n0️⃣ Menu`,
    en: `❓ *Help*\n\n🔹 Send an image to convert\n🔹 Basic: 1/day — 50 MAD/month\n🔹 Pro: unlimited — 350 MAD/month\n🔹 Support: ${CONFIG.ADMIN_PHONE}\n\n0️⃣ Menu`,
  },
  payOpts: {
    ar: (label) => `💳 *طريقة الدفع*\nالخطة: ${label}\n\n1️⃣ CashPlus (نقداً)\n2️⃣ CMI (بطاقة)\n3️⃣ تحويل بنكي\n4️⃣ Stripe\n0️⃣ رجوع`,
    fr: (label) => `💳 *Mode de paiement*\nPlan: ${label}\n\n1️⃣ CashPlus (Espèces)\n2️⃣ CMI (Carte)\n3️⃣ Virement\n4️⃣ Stripe\n0️⃣ Retour`,
    en: (label) => `💳 *Payment method*\nPlan: ${label}\n\n1️⃣ CashPlus (Cash)\n2️⃣ CMI (Card)\n3️⃣ Bank Transfer\n4️⃣ Stripe\n0️⃣ Back`,
  },
  myPlan: {
    ar: (u,d) => `📊 *اشتراكي*\n\n📦 الخطة: ${u.plan==="pro"?"المحترف 🔵":u.plan==="basic"?"الأساسي 🟢":u.plan==="trial"?"تجريبي 🎁":"لا يوجد"}\n📅 ينتهي خلال: ${d} يوم\n🧵 اليوم: ${u.files_today||0}\n📁 الإجمالي: ${u.files_total||0}`,
    fr: (u,d) => `📊 *Mon abonnement*\n\n📦 Plan: ${u.plan==="pro"?"Pro 🔵":u.plan==="basic"?"Basique 🟢":u.plan==="trial"?"Essai 🎁":"Aucun"}\n📅 Expire dans: ${d} jours\n🧵 Aujourd'hui: ${u.files_today||0}\n📁 Total: ${u.files_total||0}`,
    en: (u,d) => `📊 *My Subscription*\n\n📦 Plan: ${u.plan==="pro"?"Pro 🔵":u.plan==="basic"?"Basic 🟢":u.plan==="trial"?"Trial 🎁":"None"}\n📅 Expires in: ${d} days\n🧵 Today: ${u.files_today||0}\n📁 Total: ${u.files_total||0}`,
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
// GEMINI SMART ROUTING
// ============================================================
async function detectComplexity(b64, mime) {
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODELS.lite}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: `Reply ONE word only: "simple", "medium", or "complex".\n- simple: plain text, single color, basic shape\n- medium: logo 2-4 colors\n- complex: detailed art, many colors` }] }] },
      { timeout: 10000 }
    );
    const w = res.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    if (w.includes("simple")) return "simple";
    if (w.includes("complex")) return "complex";
    return "medium";
  } catch { return "medium"; }
}

async function analyzeImage(b64, mime) {
  try {
    const complexity = await detectComplexity(b64, mime);
    const modelKey = complexity === "simple" ? "lite" : complexity === "complex" ? "pro" : "flash";
    const model = CONFIG.GEMINI_MODELS[modelKey];
    console.log(`🤖 Complexity: ${complexity} → ${model}`);
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: `Expert embroidery digitizer. Return ONLY JSON:\n{"complexity":"simple|medium|complex","colors":["#hex"],"width_mm":80,"height_mm":80,"stitch_count":5000,"stitch_type":"satin|fill|run|mixed","description":"brief"}` }] }] },
      { timeout: 20000 }
    );
    const result = JSON.parse(res.data.candidates[0].content.parts[0].text.replace(/```json|```/g,"").trim());
    result._model = model;
    return result;
  } catch(e) {
    console.error("Gemini error:", e.message);
    return { complexity:"medium", colors:["#000000"], width_mm:80, height_mm:80, stitch_count:5000, stitch_type:"fill", description:"Design", _model:CONFIG.GEMINI_MODELS.flash };
  }
}

async function generateFile(b64, mime, analysis, phone) {
  try {
    const res = await axios.post(
      `${CONFIG.BASE_URL}/generate-embroidery`,
      { image_b64: b64, mime_type: mime, analysis, phone },
      { timeout: 60000 }
    );
    return res.data;
  } catch(e) {
    console.error("Generate file error:", e.message);
    return null;
  }
}

// ============================================================
// PAYMENT FLOWS
// ============================================================
async function payCashplus(phone, plan, lang) {
  const code = Math.floor(100000 + Math.random() * 900000);
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).paymentCode = code;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cashplus',$4)", [phone.replace(/[@c.us]/g,""), plan, amt, String(code)]);
  const t = {
    ar: `💵 *CashPlus*\n\n💰 المبلغ: *${amt} درهم*\n🔑 الكود: *${code}*\n\nادفع في أقرب نقطة CashPlus ثم أرسل:\n✅ *تم ${code}*`,
    fr: `💵 *CashPlus*\n\n💰 Montant: *${amt} MAD*\n🔑 Code: *${code}*\n\nPayez au CashPlus puis envoyez:\n✅ *payé ${code}*`,
    en: `💵 *CashPlus*\n\n💰 Amount: *${amt} MAD*\n🔑 Code: *${code}*\n\nPay at CashPlus then send:\n✅ *paid ${code}*`,
  };
  return t[lang] || t.fr;
}

async function payCMI(phone, plan, lang) {
  const oid = `EMB-${Date.now()}-${phone.slice(-4)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).orderId = oid;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'cmi',$4)", [phone.replace(/[@c.us]/g,""), plan, amt, oid]);
  const url = `https://payment.cmi.co.ma/fim/est3Dgate?clientid=${CONFIG.CMI_MERCHANT_ID}&amount=${amt}.00&currency=504&oid=${oid}&okUrl=${CONFIG.BASE_URL}/payment/cmi/success&callbackUrl=${CONFIG.BASE_URL}/payment/cmi/callback`;
  const t = {
    ar: `💳 *CMI*\n\n💰 المبلغ: *${amt} درهم*\n\nانقر للدفع:\n${url}`,
    fr: `💳 *CMI*\n\n💰 Montant: *${amt} MAD*\n\nCliquez pour payer:\n${url}`,
    en: `💳 *CMI*\n\n💰 Amount: *${amt} MAD*\n\nClick to pay:\n${url}`,
  };
  return t[lang] || t.fr;
}

async function payTransfer(phone, plan, lang) {
  const ref = `EMB${Date.now().toString().slice(-8)}`;
  const amt = CONFIG.PLANS[plan].price_mad;
  sess(phone).transferRef = ref;
  await db.query("INSERT INTO payments (phone,plan,amount_mad,method,reference) VALUES ($1,$2,$3,'transfer',$4)", [phone.replace(/[@c.us]/g,""), plan, amt, ref]);
  const t = {
    ar: `🏦 *تحويل بنكي*\n\n🏛️ Attijariwafa Bank\nRIB: *007 780 0001234567890112*\n💰 المبلغ: *${amt} درهم*\n📝 المرجع: *${ref}*\n\nأرسل صورة الإيصال`,
    fr: `🏦 *Virement bancaire*\n\n🏛️ Attijariwafa Bank\nRIB: *007 780 0001234567890112*\n💰 Montant: *${amt} MAD*\n📝 Référence: *${ref}*\n\nEnvoyez photo du reçu`,
    en: `🏦 *Bank Transfer*\n\n🏛️ Attijariwafa Bank\nRIB: *007 780 0001234567890112*\n💰 Amount: *${amt} MAD*\n📝 Reference: *${ref}*\n\nSend receipt photo`,
  };
  return t[lang] || t.fr;
}

async function payStripe(phone, plan, lang) {
  const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
  const amt = CONFIG.PLANS[plan].price_usd * 100;
  const s = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{ price_data: { currency: "usd", product_data: { name: `Stichai - ${CONFIG.PLANS[plan].label.en}` }, unit_amount: amt }, quantity: 1 }],
    mode: "payment",
    success_url: `${CONFIG.BASE_URL}/payment/stripe/success?phone=${phone.replace(/[@c.us]/g,"")}`,
    cancel_url: `${CONFIG.BASE_URL}/payment/stripe/cancel`,
    metadata: { phone: phone.replace(/[@c.us]/g,""), plan },
  });
  const t = {
    ar: `💳 *Stripe*\n\nانقر للدفع:\n${s.url}`,
    fr: `💳 *Stripe*\n\nCliquez pour payer:\n${s.url}`,
    en: `💳 *Stripe*\n\nClick to pay:\n${s.url}`,
  };
  return t[lang] || t.fr;
}

// ============================================================
// WHATSAPP CLIENT
// ============================================================
let waClient;

function initWhatsApp() {
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "/app/.wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    },
  });

  waClient.on("qr", (qr) => {
    console.log("\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n");
    qrcode.generate(qr, { small: true });
    console.log("\nOpen WhatsApp → Settings → Linked Devices → Link a Device\n");
  });

  waClient.on("ready", () => {
    console.log("✅ WhatsApp connected! Bot is ready.");
  });

  waClient.on("disconnected", (reason) => {
    console.log("❌ WhatsApp disconnected:", reason);
    setTimeout(initWhatsApp, 5000);
  });

  waClient.on("message", async (msg) => {
    try {
      if (msg.isGroupMsg) return;
      const phone = msg.from;
      const body = msg.body?.trim() || "";
      const hasMedia = msg.hasMedia;
      await handleMessage(phone, body, hasMedia, msg);
    } catch(e) {
      console.error("Message error:", e.message);
    }
  });

  waClient.initialize();
}

async function sendMsg(phone, text) {
  try {
    await waClient.sendMessage(phone, text);
  } catch(e) {
    console.error("Send error:", e.message);
  }
}

async function sendFile(phone, filePath, filename, caption) {
  try {
    const media = MessageMedia.fromFilePath(filePath);
    media.filename = filename;
    await waClient.sendMessage(phone, media, { caption });
  } catch(e) {
    console.error("Send file error:", e.message);
  }
}

// ============================================================
// PROCESS AND DELIVER
// ============================================================
async function processAndDeliver(phone, user, msg) {
  const lang = user.language || "fr";
  await sendMsg(phone, m("processing", lang));

  try {
    // Download image from WhatsApp message
    const media = await msg.downloadMedia();
    if (!media) throw new Error("Could not download media");

    const b64 = media.data;
    const mime = media.mimetype || "image/jpeg";

    // Analyze with Gemini
    const analysis = await analyzeImage(b64, mime);

    // Generate embroidery file
    const files = await generateFile(b64, mime, analysis, phone);

    await recordConversion(phone, user.plan, files?.stitch_count || 0);
    await sendMsg(phone, m("done", lang));

    if (files?.dst_url) {
      await sendMsg(phone, `📁 DST file (Tajima/Universal): ${files.dst_url}`);
      await sendMsg(phone, `📁 PES file (Brother/Janome): ${files.pes_url}`);
    } else {
      await sendMsg(phone, `⚠️ File generation service not connected yet. Analysis complete:\n\n📊 Complexity: ${analysis.complexity}\n🎨 Colors: ${analysis.colors?.length||1}\n📐 Size: ${analysis.width_mm}×${analysis.height_mm}mm\n🧵 Stitches: ~${analysis.stitch_count?.toLocaleString()}`);
    }

    const modelLabel = analysis._model?.includes("lite") ? "Flash-Lite ⚡" : analysis._model?.includes("pro") ? "Pro 🎯" : "Flash ✨";
    const summary = {
      ar: `📊 *تفاصيل التطريز:*\n🧵 الغرز: ~${(analysis.stitch_count||5000).toLocaleString()}\n📐 ${analysis.width_mm}×${analysis.height_mm}mm\n🎨 الألوان: ${analysis.colors?.length||1}\n⚡ ${analysis.complexity}\n🤖 Gemini ${modelLabel}`,
      fr: `📊 *Détails:*\n🧵 Points: ~${(analysis.stitch_count||5000).toLocaleString()}\n📐 ${analysis.width_mm}×${analysis.height_mm}mm\n🎨 Couleurs: ${analysis.colors?.length||1}\n⚡ ${analysis.complexity}\n🤖 Gemini ${modelLabel}`,
      en: `📊 *Details:*\n🧵 Stitches: ~${(analysis.stitch_count||5000).toLocaleString()}\n📐 ${analysis.width_mm}×${analysis.height_mm}mm\n🎨 Colors: ${analysis.colors?.length||1}\n⚡ ${analysis.complexity}\n🤖 Gemini ${modelLabel}`,
    };
    await sendMsg(phone, summary[lang]);
    sess(phone).step = "menu";
    await sendMsg(phone, m("menu", lang));

  } catch(e) {
    console.error("Deliver error:", e.message);
    await sendMsg(phone, m("error", lang));
  }
}

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================
async function handleMessage(phone, body, hasMedia, msg) {
  const user = await getUser(phone);
  const lang = user.language || "fr";
  const s = sess(phone);
  const t = body.trim();
  const tl = t.toLowerCase();

  // Global shortcuts
  if (["0","menu","قائمة","retour","back"].includes(tl)) { s.step = "menu"; return sendMsg(phone, m("menu", lang)); }
  if (["help","aide","مساعدة"].includes(tl)) return sendMsg(phone, m("help", lang));
  if (["upgrade","ترقية"].includes(tl)) { s.step = "plans"; return sendMsg(phone, m("plans", lang)); }

  switch(s.step) {

    case "start":
      await sendMsg(phone, MSG.welcome.fr);
      s.step = "choose_language";
      break;

    case "choose_language":
      if (["1","2","3"].includes(t)) {
        const lmap = {"1":"ar","2":"fr","3":"en"};
        await updateUser(phone, { language: lmap[t] });
        s.step = "menu";
        return sendMsg(phone, m("menu", lmap[t]));
      }
      await sendMsg(phone, MSG.welcome.fr);
      break;

    case "menu":
      if (t === "1") {
        const check = await canConvert(user);
        if (!check.ok) {
          if (check.reason === "limit") return sendMsg(phone, m("limitReached", lang));
          s.step = "no_sub";
          return sendMsg(phone, m("noSub", lang));
        }
        s.step = "waiting_image";
        return sendMsg(phone, m("askImage", lang));
      }
      if (t === "2") {
        const active = await isSubActive(user);
        if (!active) { s.step = "no_sub"; return sendMsg(phone, m("noSub", lang)); }
        const days = Math.ceil((new Date(user.plan_end) - new Date()) / 86400000);
        return sendMsg(phone, m("myPlan", lang, user, days));
      }
      if (t === "3") { s.step = "plans"; return sendMsg(phone, m("plans", lang)); }
      if (t === "4") { s.step = "enter_code"; return sendMsg(phone, m("askCode", lang)); }
      if (t === "5") return sendMsg(phone, m("help", lang));
      await sendMsg(phone, m("menu", lang));
      break;

    case "no_sub":
      if (t === "1") { s.step = "plans"; return sendMsg(phone, m("plans", lang)); }
      if (t === "2") { s.step = "enter_code"; return sendMsg(phone, m("askCode", lang)); }
      await sendMsg(phone, m("noSub", lang));
      break;

    case "enter_code": {
      const result = await redeemCode(t, phone);
      if (result.ok) {
        s.step = "menu";
        await sendMsg(phone, m("codeOk", lang, result.days, result.plan));
        return sendMsg(phone, m("menu", lang));
      }
      if (result.reason === "already_used") return sendMsg(phone, m("codeUsed", lang));
      return sendMsg(phone, m("codeBad", lang));
    }

    case "plans":
      if (t === "1") { s.selectedPlan = "basic"; s.step = "choose_payment"; return sendMsg(phone, m("payOpts", lang, CONFIG.PLANS.basic.label[lang])); }
      if (t === "2") { s.selectedPlan = "pro";   s.step = "choose_payment"; return sendMsg(phone, m("payOpts", lang, CONFIG.PLANS.pro.label[lang])); }
      if (t === "3") { s.step = "enter_code"; return sendMsg(phone, m("askCode", lang)); }
      await sendMsg(phone, m("plans", lang));
      break;

    case "choose_payment": {
      const pl = s.selectedPlan;
      let reply;
      if (t === "1") { s.step = "waiting_cashplus"; reply = await payCashplus(phone, pl, lang); }
      else if (t === "2") { s.step = "waiting_cmi"; reply = await payCMI(phone, pl, lang); }
      else if (t === "3") { s.step = "waiting_transfer"; reply = await payTransfer(phone, pl, lang); }
      else if (t === "4") { s.step = "waiting_stripe"; reply = await payStripe(phone, pl, lang); }
      else reply = m("payOpts", lang, CONFIG.PLANS[pl].label[lang]);
      await sendMsg(phone, reply);
      break;
    }

    case "waiting_cashplus": {
      const code = s.paymentCode?.toString();
      const ok = t.includes(code) && (t.includes("تم") || t.includes("paid") || t.includes("payé"));
      if (ok) {
        await activatePlan(phone, s.selectedPlan);
        await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='cashplus' AND status='pending'", [phone.replace(/[@c.us]/g,"")]);
        s.step = "menu";
        await sendMsg(phone, m("activated", lang, CONFIG.PLANS[s.selectedPlan].label[lang]));
        return sendMsg(phone, m("menu", lang));
      }
      const wait = { ar: `⏳ في انتظار دفعك...\nأرسل: *تم ${s.paymentCode}*`, fr: `⏳ En attente...\nEnvoyez: *payé ${s.paymentCode}*`, en: `⏳ Waiting...\nSend: *paid ${s.paymentCode}*` };
      await sendMsg(phone, wait[lang] || wait.fr);
      break;
    }

    case "waiting_transfer":
      if (hasMedia) {
        await activatePlan(phone, s.selectedPlan);
        await db.query("UPDATE payments SET status='confirmed' WHERE phone=$1 AND method='transfer' AND status='pending'", [phone.replace(/[@c.us]/g,"")]);
        s.step = "menu";
        await sendMsg(phone, m("activated", lang, CONFIG.PLANS[s.selectedPlan].label[lang]));
        return sendMsg(phone, m("menu", lang));
      }
      break;

    case "waiting_image":
      if (hasMedia) {
        const freshUser = await getUser(phone);
        return processAndDeliver(phone, freshUser, msg);
      }
      await sendMsg(phone, m("askImage", lang));
      break;

    default:
      s.step = "menu";
      await sendMsg(phone, m("menu", lang));
  }
}

// ============================================================
// EXPRESS ROUTES
// ============================================================

// Stripe webhook
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
      sess(phone).step = "menu";
      await sendMsg(`${phone}@c.us`, m("activated", lang, CONFIG.PLANS[plan].label[lang]));
      await sendMsg(`${phone}@c.us`, m("menu", lang));
    }
    res.json({ received: true });
  } catch(e) { res.status(400).send(e.message); }
});

// CMI callback
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
      await sendMsg(`${phone}@c.us`, m("activated", lang, CONFIG.PLANS[plan].label[lang]));
      await sendMsg(`${phone}@c.us`, m("menu", lang));
    }
  }
  res.send("ACTION=POSTAUTH");
});

app.get("/payment/stripe/success", (_, res) =>
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4"><h1 style="color:#16a34a">✅ Payment Successful!</h1><p>Check WhatsApp — your subscription is now active! 🧵</p></body></html>`)
);

// Landing page
app.get("/", (_, res) => res.sendFile("/app/index.html"));

// Admin routes
function adminAuth(req, res) {
  const s = req.body?.secret || req.query?.secret;
  if (s !== CONFIG.ADMIN_SECRET) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

app.post("/admin/code", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { plan = "trial", days = 7, maxUses = 1, prefix = "EMB" } = req.body;
  const code = await createCode({ plan, days, maxUses, prefix });
  res.json({ code, plan, days, maxUses });
});

app.post("/admin/codes/bulk", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { count = 10, plan = "trial", days = 7, maxUses = 1, prefix = "EMB" } = req.body;
  const codes = [];
  for (let i = 0; i < count; i++) codes.push(await createCode({ plan, days, maxUses, prefix }));
  res.json({ codes, count: codes.length });
});

app.post("/admin/send-code", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, plan = "trial", days = 7 } = req.body;
  const code = await createCode({ plan, days, maxUses: 1 });
  const user = await getUser(phone);
  const lang = user.language || "fr";
  const t = {
    ar: `🎁 *هدية من Stichai!*\n\nكودك التجريبي:\n🎟️ *${code}*\n\n✨ ${days} أيام — ${plan==="pro"?"المحترف 🔵":"الأساسي 🟢"}`,
    fr: `🎁 *Cadeau de Stichai!*\n\nVotre code:\n🎟️ *${code}*\n\n✨ ${days} jours — ${plan==="pro"?"Pro 🔵":"Basique 🟢"}`,
    en: `🎁 *Gift from Stichai!*\n\nYour code:\n🎟️ *${code}*\n\n✨ ${days} days — ${plan==="pro"?"Pro 🔵":"Basic 🟢"}`,
  };
  await sendMsg(`${phone}@c.us`, t[lang] || t.fr);
  res.json({ success: true, code, phone });
});

app.get("/admin/codes", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const r = await db.query("SELECT * FROM trial_codes ORDER BY created_at DESC LIMIT 100");
  res.json(r.rows);
});

app.get("/admin/stats", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const [users, revenue, conversions, codes] = await Promise.all([
    db.query(`SELECT COUNT(*) total, COUNT(CASE WHEN plan='basic' AND plan_end > NOW() THEN 1 END) basic, COUNT(CASE WHEN plan='pro' AND plan_end > NOW() THEN 1 END) pro, COUNT(CASE WHEN plan='trial' AND plan_end > NOW() THEN 1 END) trial FROM users`),
    db.query("SELECT SUM(amount_mad) total_mad, COUNT(*) total_payments FROM payments WHERE status='confirmed'"),
    db.query("SELECT COUNT(*) total, SUM(stitch_count) total_stitches FROM conversions"),
    db.query("SELECT COUNT(*) total, SUM(used_count) used FROM trial_codes WHERE active=TRUE"),
  ]);
  res.json({ users: users.rows[0], revenue: revenue.rows[0], conversions: conversions.rows[0], trial_codes: codes.rows[0] });
});

app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime(), version: "3.0", whatsapp: waClient?.info ? "connected" : "connecting" }));

// ============================================================
// BOOT
// ============================================================
const PORT = process.env.PORT || 3000;
(async () => {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🧵 Stichai Embroidery Bot v3.0 on port ${PORT}`);
    console.log(`🌐 Website: ${CONFIG.BASE_URL}`);
  });
  initWhatsApp();
})();
