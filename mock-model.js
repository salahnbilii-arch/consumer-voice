/* ============================================================================
 * MOCK MODEL LAYER — Phase 0 ONLY.
 * This file is a deterministic placeholder. It makes NO network calls and
 * needs NO API key. Phase 1 replaces it with Muse Spark Open via Baseten
 * (model id: meta-models/muse-spark-open-1026, base URL:
 * https://inference.baseten.co/v1) behind the SAME function contract:
 *   structureComplaint({ transcript }) -> Promise<{
 *     company, issue, demand, amount, category, letterAr, letterFr,
 *     extractionNotes }>
 * Phase 1 notes (from the provider facts on record):
 * - Baseten Spark Open does NOT support structured outputs / JSON mode,
 *   so Phase 1 MUST validate the model's JSON in code before using it.
 * - The UI (app.js), the trace panel, and the verification check contract
 *   stay unchanged; only this file's internals change.
 * ========================================================================== */

const MOCK = true; // <-- Phase 0 marker. Phase 1 sets the real model client here.

/* Normalize Arabic-Indic / Eastern Arabic digits to Latin digits. */
function normalizeDigits(s) {
  const map = {
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  };
  return String(s).replace(/[٠-٩۰-۹]/g, (c) => map[c]);
}

/* Keyword tables: spoken Darija/Arabic/French -> canonical case fields.
 * NOTE: no real brand or company names appear anywhere in these tables. */
const CATEGORY_KEYWORDS = [
  ["delivery", ["توصيل", "وصل", "طلبية", "كوموند", "livraison", "commande"]],
  ["telecom", ["رصيد", "اشتراك", "فاتورة", "هاتف", "تعبئة", "forfait", "abonnement"]],
  ["bank", ["بنك", "قرض", "بطاقة", "حساب بنكي", "banque", "crédit"]],
  ["internet", ["أنترنت", "انترنت", "ويفي", "راوتر", "wifi", "internet"]],
  ["shop", ["متجر", "محل", "حانوت", "شريت", "سلعة", "magasin", "achat"]],
];

const ISSUE_KEYWORDS = [
  ["سلعة خاسرة / معيبة", ["خاسر", "مخسر", "ما خدامش", "معيب", "مهرس", "défectueux", "cassé", "ne fonctionne pas"]],
  ["زيادة في الفاتورة / ثمن غير متفق عليه", ["زادو عليا", "فاتورة", "ثمن", "غالي", "surfacturation", "facture"]],
  ["طلبية ما وصلاتش", ["ما وصلش", "ما وصلات", "توصيل", "non livré", "pas reçu"]],
  ["تأخر", ["تعطل", "تأخر", "retard"]],
  ["سلعة غالطة", ["غلط", "ماشي هو", "ماشي هي", "mauvais article", "erreur"]],
  ["معاملة سيئة / خدمة ضعيفة", ["معاملة", "خايبة", "مكايجاوبوش", "mauvais service"]],
];

const DEMAND_KEYWORDS = [
  ["استرجاع المبلغ", ["رجع", "استرجاع", "فلوسي", "remboursement", "rembourser"]],
  ["تبديل السلعة", ["بدل", "تبديل", "échange", "remplacement"]],
  ["إصلاح السلعة", ["صلح", "إصلاح", "réparation", "réparer"]],
  ["إلغاء الاشتراك", ["ألغي", "إلغاء", "annulation", "résilier"]],
  ["تعويض", ["تعويض", "indemnisation"]],
  ["اعتذار رسمي", ["اعتذار", "excuses"]],
];

function firstMatch(text, table) {
  for (const [label, words] of table) {
    for (const w of words) {
      if (text.includes(w)) return label;
    }
  }
  return "";
}

/* Company extraction: "من عند X" / "شركة X" / "متجر X" / "محل X" (+ FR).
 * If nothing matches, company stays empty on purpose: the verification
 * check then FAILS and asks the user to name the company. The mock never
 * invents a company name. */
function extractCompany(text) {
  const m = text.match(/(?:من عند|من شركة|من متجر|من محل|شركة|متجر|محل|chez|magasin|société)\s+([^\s،,.;:]+(?:\s+[^\s،,.;:]+)?)/);
  if (!m) return "";
  /* Drop trailing tokens that are not part of a name: the "بـ" preposition
   * before a price, currency words, and bare numbers. */
  const STOP = new Set(["ب", "بـ", "بثمن", "درهم", "د.م.", "dh", "mad"]);
  const tokens = m[1].split(/\s+/).filter((t) => !STOP.has(t) && !/^\d/.test(t));
  if (!tokens.length) return "";
  return tokens.join(" ").trim();
}

/* Amount: number adjacent to a currency word, else the first number. */
function extractAmount(text) {
  const norm = normalizeDigits(text);
  const m = norm.match(/(\d[\d\s]*\d|\d)\s*(درهم|د\.م\.|DH|MAD|دينار)?/);
  if (!m) return "";
  const hasCurrency = /(درهم|د\.م\.|DH|MAD)/.test(norm);
  const num = (norm.match(/\d[\d\s]*/g) || [""])[0].replace(/\s/g, "");
  if (!num) return "";
  return hasCurrency || num.length >= 2 ? num : "";
}

function buildLetterAr(c) {
  return [
    "الموضوع: شكاية بخصوص " + (c.issue || "مشكل استهلاكي"),
    "",
    "إلى السيد(ة) مسؤول خدمة الزبناء،",
    "",
    "أنا الموقع(ة) أسفله، أتقدم بهذه الشكاية ضد: " + (c.company || "——") + ".",
    "الوقائع: " + (c.issue || "——") + ".",
    c.amount ? "المبلغ المعني: " + c.amount + " درهم." : "",
    "المطلوب: " + (c.demand || "——") + ".",
    "",
    "[مرجع قانون حماية المستهلك — قيد التحقق، لا يُدرج أي رقم مادة قبل التحقق من الأحكام أثناء البناء]",
    "",
    "أطلب تسوية هذا الملف داخل أجل معقول، مع إشعاري كتابة بالنتيجة.",
    "وتقبلوا فائق الاحترام.",
  ].filter(Boolean).join("\n");
}

function buildLetterFr(c) {
  return [
    "Objet : Réclamation concernant " + (c.issue || "un problème de consommation"),
    "",
    "Madame, Monsieur,",
    "",
    "Je porte plainte contre : " + (c.company || "——") + ".",
    "Faits : " + (c.issue || "——") + ".",
    c.amount ? "Montant concerné : " + c.amount + " DH." : "",
    "Demande : " + (c.demand || "——") + ".",
    "",
    "[Référence légale (protection du consommateur) — en cours de vérification ; aucun article ne sera cité avant vérification pendant la construction]",
    "",
    "Je vous prie de régler ce dossier dans un délai raisonnable et de me notifier le résultat par écrit.",
    "Cordialement.",
  ].filter(Boolean).join("\n");
}

/**
 * MOCK contract — deterministic keyword structuring (Phase 0).
 * Empty fields are honest gaps, not guesses: the verification check in
 * app.js turns them into visible feedback for the user to fix.
 */
async function structureComplaint({ transcript }) {
  const text = normalizeDigits(transcript || "").toLowerCase();
  const company = extractCompany(text);
  const issue = firstMatch(text, ISSUE_KEYWORDS);
  const demand = firstMatch(text, DEMAND_KEYWORDS);
  const amount = extractAmount(text);
  const category = firstMatch(text, CATEGORY_KEYWORDS) || "other";
  const notes = [];
  if (!company) notes.push("لم يتم تحديد اسم الشركة — اكتبه بنفسك في الحقل.");
  if (!issue) notes.push("لم يتم تحديد نوع المشكل — اكتبه بنفسك في الحقل.");
  if (!demand) notes.push("لم يتم تحديد المطلوب — اكتبه بنفسك في الحقل.");
  const c = { company, issue, demand, amount, category };
  return {
    ...c,
    letterAr: buildLetterAr(c),
    letterFr: buildLetterFr(c),
    extractionNotes: notes,
  };
}
