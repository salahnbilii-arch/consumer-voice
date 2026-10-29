/* Consumer Voice — Phase 0 + Phase 1 app logic (fresh code, event week).
 * Wires browser speech (with fallbacks), the model layer (LIVE proxy
 * first, MOCK fallback — see live-model.js), the HARD
 * non-skippable verification check, the review step, the publish flow,
 * the public board, and the visible trace log.
 *
 * Agents-102 rule applied here: the verification check is INSIDE the
 * publish action itself (publish re-runs it), not just a button state.
 * A publish can never bypass a failed check, even if the user edits the
 * fields after a pass.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let lastCheckPassed = false;
  let recognition = null;

  /* --- Army mode (Phase 2, ?army=1) -----------------------------------
   * Everything in this block is additive and guarded by ARMY_MODE: the
   * default path below is byte-identical in behavior when the flag is
   * absent. In army mode the structure step calls the Worker /army
   * pipeline, renders the agent trace + approval card, and publish is
   * gated on BOTH the existing verification pass AND explicit human
   * approval. Reject stops the run and logs the reason. */
  const ARMY_MODE =
    typeof window !== "undefined" &&
    typeof window.location !== "undefined" &&
    new URLSearchParams(window.location.search).get("army") === "1";
  let armyApproval = "pending"; // pending | approved | rejected
  let armyState = null;

  function renderArmyTrace(a) {
    const panel = $("army-panel");
    const list = $("army-steps");
    if (!panel || !list) return;
    panel.classList.remove("hidden");
    list.innerHTML = "";
    const AGENT_NAMES = {
      listener: "1 · Darija Listener — فهم الشكوى",
      organizer: "2 · Case Organizer — تنظيم القضية",
      researcher: "3 · Company Researcher — بحث الشركة والقوانين",
      writer: "4 · Letter Writer — الرسائل الرسمية",
      pressure: "5 · Public Pressure — منشور اللوحة",
      approval_gate: "⛔ بوابة الموافقة البشرية — متوقفة بانتظار قرارك",
    };
    for (const t of a.trace) {
      const li = document.createElement("li");
      li.textContent =
        (AGENT_NAMES[t.agent] || t.agent) +
        (t.status === "ok"
          ? ` — تم${t.ms ? ` (${t.ms}ms)` : ""}`
          : t.status === "waiting"
            ? " — بانتظار قرارك (النشر والإرسال والتواصل مع الشركة مقفلة)"
            : ` — ${t.status}`);
      list.appendChild(li);
    }
    const sum = $("army-summary");
    if (sum) {
      sum.textContent =
        `${a.caseTitle} — ${a.factsSummary}` +
        (a.companyActivity ? ` — النشاط: ${a.companyActivity}.` : "") +
        (a.lawAreas.length ? ` مجالات قانونية عامة: ${a.lawAreas.join("، ")}.` : "") +
        (a.researchNotes ? ` ملاحظة البحث: ${a.researchNotes}` : "");
    }
  }

  function showApprovalCard(a) {
    const card = $("approval-card");
    if (!card) return;
    card.classList.remove("hidden");
    const post = $("army-post");
    if (post) post.textContent = a.publicPost;
    const st = $("approval-status");
    if (st) st.textContent = "القرار: بانتظارك — لا نشر ولا إرسال قبل موافقتك الصريحة.";
    armyApproval = "pending";
    $("btn-publish").disabled = true;
  }

  /* --- Model-layer indicator (Phase 1) ---------------------------------
   * The banner + tag always show which layer produced the LAST structured
   * case, honestly: LIVE = Muse Spark Open via the Worker proxy;
   * MOCK = the offline placeholder; MOCK (بديل) = the proxy failed and
   * the MOCK layer was used as a fallback. "live-ready" = the proxy URL
   * is configured but no case has been structured yet (nothing claims to
   * be live before a live call actually succeeds). */
  function modelLabel(source) {
    return source === "live"
      ? "LIVE"
      : source === "mock-fallback"
        ? "MOCK (بديل)"
        : "MOCK";
  }
  function setModelIndicator(source) {
    const banner = $("model-banner");
    if (banner) {
      if (source === "live") {
        banner.className = "live-banner";
        banner.textContent =
          "النموذج الحي: Muse Spark Open عبر Baseten (الوسيط) — آخر تنظيم بهذا النموذج. الصوت عبر واجهات المتصفح فقط.";
      } else if (source === "live-ready") {
        banner.className = "live-banner";
        banner.textContent =
          "الوسيط الحي مضبوط — التنظيم غادي يكون بـ Muse Spark Open عبر Baseten، و MOCK كبديل إلا فشل الاتصال.";
      } else if (source === "mock-fallback") {
        banner.className = "mock-banner";
        banner.textContent =
          "⚠️ الوسيط الحي فشل — النموذج الحالي MOCK (بديل بلا اتصال): لا يتصل بأي نموذج حقيقي ولا يحتاج مفتاحا.";
      } else {
        banner.className = "mock-banner";
        banner.textContent =
          "⚠️ نسخة تجريبية — النموذج الحالي MOCK: لا يتصل بأي نموذج حقيقي ولا يحتاج مفتاحا. المرحلة 1 غادي تعوضو بـ Muse Spark Open عبر Baseten.";
      }
    }
    const tag = $("model-tag");
    if (tag) {
      tag.textContent =
        source === "live" ? "LIVE · Spark Open" : modelLabel(source);
    }
  }

  /* --- Seed board: OBVIOUSLY FICTIONAL demo data, labeled in the UI. --- */
  const board = [
    { company: "متجر تجريبي أ", category: "shop", issue: "سلعة خاسرة / معيبة",
      demand: "استرجاع المبلغ", amount: "500", resolved: false, reports: 0, demo: true },
    { company: "متجر تجريبي أ", category: "shop", issue: "سلعة غالطة",
      demand: "تبديل السلعة", amount: "", resolved: true, reports: 0, demo: true },
    { company: "شركة توصيل تجريبية", category: "delivery", issue: "طلبية ما وصلاتش",
      demand: "استرجاع المبلغ", amount: "120", resolved: false, reports: 0, demo: true },
  ];

  const CATEGORY_LABELS = {
    shop: "متجر / سلعة", telecom: "اتصالات", delivery: "توصيل",
    bank: "بنك / مالية", internet: "أنترنت", other: "أخرى",
  };

  /* Forbidden-content blocklist (illustrative Phase 0 set; Phase 1 extends
   * it): severe insults, threats, and personal-data patterns. A public
   * board must never carry these. */
  const FORBIDDEN_WORDS = [
    "قحبة", "حمار", "كلب", "الله ينعل", "نقتلك", "نضربك",
    "pute", "connard", "je vais te tuer",
  ];
  const PHONE_RE = /(?:0[567]\d{8}|\d{9,})/;
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  function escapeHtml(s) {
    return String(s).replace(/[&<>\"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function trace(text, cls) {
    const li = document.createElement("li");
    li.innerHTML = cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    $("trace-log").prepend(li);
  }

  /* --- The HARD check: company + issue + demand present, nothing forbidden.
   * Returns { passed, missing[], forbidden[], detail }. */
  function verifyCase(c) {
    const missing = [];
    if (!c.company.trim()) missing.push("اسم الشركة");
    if (!c.issue.trim()) missing.push("وصف المشكل");
    if (!c.demand.trim()) missing.push("المطلوب");
    const hay = `${c.company} ${c.issue} ${c.demand}`.toLowerCase();
    const forbidden = [];
    for (const w of FORBIDDEN_WORDS) {
      if (hay.includes(w)) forbidden.push(`كلمة محظورة: ${w}`);
    }
    if (PHONE_RE.test(hay)) forbidden.push("رقم هاتف — لا تنشر بيانات شخصية");
    if (EMAIL_RE.test(hay)) forbidden.push("بريد إلكتروني — لا تنشر بيانات شخصية");
    const passed = missing.length === 0 && forbidden.length === 0;
    const detail = passed
      ? "PASS — الشركة + المشكل + المطلوب حاضرون، ولا محتوى محظور."
      : "FAIL — " +
        (missing.length ? `ناقص: ${missing.join("، ")}. ` : "") +
        (forbidden.length ? `محظور: ${forbidden.join("، ")}.` : "");
    return { passed, missing, forbidden, detail };
  }

  function companyScore(company) {
    const cases = board.filter((b) => b.company === company);
    const resolved = cases.filter((b) => b.resolved).length;
    const pct = cases.length ? Math.round((resolved / cases.length) * 100) : 0;
    return `نقطة الشركة: ${pct}% (${cases.length} قضايا، ${resolved} محلولة)`;
  }

  function renderBoard() {
    const wrap = $("board");
    wrap.innerHTML = "";
    for (const b of board) {
      const div = document.createElement("div");
      div.className = "case";
      div.innerHTML =
        `<strong>${escapeHtml(b.company)}</strong> · ${escapeHtml(CATEGORY_LABELS[b.category] || b.category)}` +
        (b.demo ? ` <span class="demo-badge">بيانات تجريبية — للعرض فقط</span>` : "") +
        `<div>${escapeHtml(b.issue)} — المطلوب: ${escapeHtml(b.demand)}` +
        (b.amount ? ` — المبلغ: ${escapeHtml(b.amount)} درهم` : "") + "</div>" +
        `<div class="claim">ادعاء مستخدم — غير مثبت</div>` +
        `<div class="score">${escapeHtml(companyScore(b.company))}</div>` +
        `<div class="reply">رد الشركة: <em>بانتظار الرد</em></div>` +
        `<button type="button" class="report">إبلاغ${b.reports ? ` (${b.reports})` : ""}</button>`;
      div.querySelector(".report").onclick = (ev) => {
        b.reports += 1;
        ev.target.textContent = `تم الإبلاغ (${b.reports})`;
        ev.target.disabled = true;
        trace(`إبلاغ عن قضية: ${b.company} — ${b.issue}`, "");
      };
      wrap.appendChild(div);
    }
  }

  function readCaseFields() {
    return {
      company: $("field-company").value.trim(),
      issue: $("field-issue").value.trim(),
      demand: $("field-demand").value.trim(),
      amount: $("field-amount").value.trim(),
      category: $("field-category").value,
    };
  }

  function showCheck(result) {
    const el = $("check-result");
    el.className = "check " + (result.passed ? "pass" : "fail");
    el.textContent = result.detail;
  }

  /* --- Flow: structure (Phase 1: LIVE proxy first, MOCK fallback) ----- */
  $("btn-structure").onclick = async () => {
    const transcript = $("complaint-text").value.trim();
    if (!transcript) {
      $("voice-status").textContent = "اكتب أو تكلم بشكايتك أولا.";
      return;
    }
    /* ARMY MODE: try the 5-agent pipeline first. On any failure, fall
     * through to the proven single-call path below — never fake data. */
    if (
      ARMY_MODE &&
      typeof LIVE_CONFIG !== "undefined" &&
      !!LIVE_CONFIG.PROXY_URL &&
      typeof structureComplaintArmy === "function"
    ) {
      $("voice-status").textContent = "…جار تشغيل الجيش (5 وكلاء)";
      try {
        const a = await structureComplaintArmy({ transcript });
        armyState = a;
        armyApproval = "pending";
        $("field-company").value = a.company;
        $("field-issue").value = a.issue;
        $("field-demand").value = a.demand;
        $("field-amount").value = a.amount;
        $("field-category").value = a.category;
        $("letter-ar").textContent = a.letterAr;
        $("letter-fr").textContent = a.letterFr;
        $("panel-case").classList.remove("hidden");
        $("panel-letter").classList.remove("hidden");
        renderArmyTrace(a);
        showApprovalCard(a);
        setModelIndicator("live");
        lastCheckPassed = false;
        $("btn-publish").disabled = true;
        $("voice-status").textContent = "";
        trace(`نص الشكاية: ${transcript}`, "");
        trace(`الجيش أكمل 5 وكلاء — القضية: ${a.caseTitle} — بانتظار الموافقة البشرية.`, "");
        if (a.extractionNotes && a.extractionNotes.length) {
          trace(`ملاحظات الاستخراج: ${a.extractionNotes.join(" ")}`, "fail");
        }
        return;
      } catch (e) {
        trace(
          `فشل مسار الجيش (${e && e.message ? e.message : "خطأ"}) — استعمال الطريق الأحادي كبديل.`,
          "fail"
        );
      }
    }
    /* Default path = the proxy. The MOCK layer runs ONLY when the proxy
     * URL is unset or the proxy call fails — and the indicator + trace
     * always say which layer produced the case. */
    const proxyConfigured =
      typeof LIVE_CONFIG !== "undefined" &&
      !!LIVE_CONFIG.PROXY_URL &&
      typeof structureComplaintLive === "function";
    let s = null;
    let source = "mock";
    if (proxyConfigured) {
      $("voice-status").textContent = "…جار التنظيم (LIVE)";
      try {
        s = await structureComplaintLive({ transcript });
        source = "live";
      } catch (e) {
        trace(
          `فشل الاتصال بالوسيط الحي (${e && e.message ? e.message : "خطأ"}) — استعمال MOCK كبديل.`,
          "fail"
        );
        s = await structureComplaint({ transcript });
        source = "mock-fallback";
      }
    } else {
      $("voice-status").textContent = "…جار التنظيم (MOCK)";
      s = await structureComplaint({ transcript });
      source = "mock";
    }
    setModelIndicator(source);
    $("field-company").value = s.company;
    $("field-issue").value = s.issue;
    $("field-demand").value = s.demand;
    $("field-amount").value = s.amount;
    $("field-category").value = s.category;
    $("letter-ar").textContent = s.letterAr;
    $("letter-fr").textContent = s.letterFr;
    $("panel-case").classList.remove("hidden");
    $("panel-letter").classList.remove("hidden");
    lastCheckPassed = false;
    $("btn-publish").disabled = true;
    $("voice-status").textContent = "";
    trace(`نص الشكاية: ${transcript}`, "");
    trace(`حقول مستخرجة (${modelLabel(source)}): شركة=${s.company || "—"}، مشكل=${s.issue || "—"}، مطلوب=${s.demand || "—"}، مبلغ=${s.amount || "—"}، فئة=${s.category}`, "");
    if (s.extractionNotes && s.extractionNotes.length) {
      trace(`ملاحظات الاستخراج: ${s.extractionNotes.join(" ")}`, "fail");
    }
  };

  /* --- Flow: verify (visible) -------------------------------------------- */
  $("btn-verify").onclick = () => {
    const c = readCaseFields();
    const result = verifyCase(c);
    showCheck(result);
    lastCheckPassed = result.passed;
    /* Army mode: verify alone never enables publish — explicit human
     * approval is also required. Default path: identical to before. */
    $("btn-publish").disabled = !(result.passed && (!ARMY_MODE || armyApproval === "approved"));
    trace(`نتيجة التحقق: ${result.detail}`, result.passed ? "pass" : "fail");
    if (!result.passed) {
      trace("إجراء مطلوب: صحح الحقول أعلاه ثم أعد التحقق (الحد الأقصى غير محدود للتصحيح، لكن النشر يبقى مقفلا).", "fail");
    }
  };

  /* --- Flow: publish — the check runs AGAIN inside this action. --------- */
  $("btn-publish").onclick = () => {
    /* ARMY GATE: publish without explicit human approval is refused,
     * even if verification passed. This is the gate's second lock (the
     * first is the disabled button above). */
    if (ARMY_MODE && armyState && armyApproval !== "approved") {
      trace("النشر مرفوض — بانتظار الموافقة البشرية (بوابة الجيش).", "fail");
      return;
    }
    const c = readCaseFields();
    const result = verifyCase(c);
    if (!result.passed) {
      showCheck(result);
      lastCheckPassed = false;
      $("btn-publish").disabled = true;
      trace(`النشر مرفوض — التحقق داخل إجراء النشر فشل: ${result.detail}`, "fail");
      return;
    }
    board.unshift({ ...c, resolved: false, reports: 0, demo: false });
    renderBoard();
    trace(`نُشرت قضية: ${c.company} — ${c.issue} — مطلوب: ${c.demand}`, "pass");
    if (ARMY_MODE && armyState) {
      trace("النشر تم بعد موافقة بشرية صريحة (بوابة الجيش).", "pass");
    }
    lastCheckPassed = false;
    $("btn-publish").disabled = true;
    showCheck({ passed: true, detail: "تم النشر. القضية تظهر أعلاه كادعاء مستخدم، مع خانة رد الشركة وزر إبلاغ." });
  };

  /* --- Approval card buttons (army mode only; guarded if absent) -------- */
  if ($("btn-approve")) {
    $("btn-approve").onclick = () => {
      if (!armyState) return;
      armyApproval = "approved";
      $("approval-status").textContent = "القرار: موافقة — النشر مسموح بعد نجاح التحقق.";
      $("btn-publish").disabled = !lastCheckPassed;
      trace("موافقة بشرية: تمت الموافقة على النشر والإرسال.", "pass");
    };
    $("btn-edit").onclick = () => {
      if (!armyState) return;
      armyApproval = "pending";
      $("approval-status").textContent = "القرار: تعديل — صحح الحقول أعلاه ثم أعد التحقق والموافقة.";
      $("btn-publish").disabled = true;
      trace("موافقة بشرية: طلب تعديل — النشر مقفل حتى موافقة جديدة.", "fail");
      $("field-company").focus();
    };
    $("btn-reject").onclick = () => {
      if (!armyState) return;
      armyApproval = "rejected";
      const reason = $("reject-reason") ? $("reject-reason").value.trim() : "";
      $("approval-status").textContent = "القرار: رفض — العملية متوقفة.";
      $("btn-publish").disabled = true;
      trace("رفض بشري — العملية متوقفة." + (reason ? ` السبب: ${reason}` : ""), "fail");
    };
  }

  /* --- Voice in (browser SpeechRecognition, ar-MA, with fallback) ------- */
  $("btn-voice").onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      $("voice-status").textContent = "المتصفح لا يدعم التعرف الصوتي — اكتب شكايتك.";
      return;
    }
    if (!recognition) {
      recognition = new SR();
      recognition.lang = "ar-MA";
      recognition.interimResults = false;
      recognition.onresult = (ev) => {
        const text = ev.results[0][0].transcript;
        const ta = $("complaint-text");
        ta.value = ta.value ? ta.value + " " + text : text;
        $("voice-status").textContent = "تم الاستماع: " + text;
        trace(`صوت → نص: ${text}`, "");
      };
      recognition.onerror = (ev) => {
        $("voice-status").textContent = "تعذر الاستماع (" + ev.error + ") — حاول مجددا أو اكتب.";
      };
    }
    $("voice-status").textContent = "…استمع الآن";
    try { recognition.start(); } catch (e) { /* already started */ }
  };

  /* --- Voice out (browser SpeechSynthesis, summary only) --------------- */
  $("btn-listen").onclick = () => {
    if (!("speechSynthesis" in window)) {
      $("voice-status").textContent = "المتصفح لا يدعم النطق.";
      return;
    }
    const c = readCaseFields();
    const summary = `الشركة: ${c.company || "غير محددة"}. المشكل: ${c.issue || "غير محدد"}. المطلوب: ${c.demand || "غير محدد"}.`;
    const u = new SpeechSynthesisUtterance(summary);
    u.lang = "ar-MA";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    trace(`نطق الملخص: ${summary}`, "");
  };

  /* --- Init -------------------------------------------------------------- */
  renderBoard();
  trace("لوحة تجريبية: 3 قضايا وهمية بأسماء خيالية (بيانات تجريبية — للعرض فقط).", "");
  if (ARMY_MODE) {
    trace("وضع الجيش مفعّل (?army=1): التنظيم عبر 5 وكلاء + بوابة موافقة بشرية إجبارية قبل أي نشر أو إرسال.", "");
  }
  setModelIndicator(
    typeof LIVE_CONFIG !== "undefined" && LIVE_CONFIG.PROXY_URL
      ? "live-ready"
      : "mock"
  );
})();
