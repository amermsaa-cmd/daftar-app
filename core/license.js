// @ts-check
// نواة الاشتراك المشتركة (الكمبيوتر والجوال): بلا ملفات ولا مكتبات تشفير، والمضيف يمرّر التحقق والتخزين.
// - كود تفعيل موقّع Ed25519 ومربوط برمز الجهاز، يعمل بدون إنترنت (صيغة الأداة القديمة نفسها + حقل الباقة k + مفتاح البقالة sk).
// - الحالات: غير مفعّل ← فعّال ← تنبيه قبل الانتهاء بـ7 أيام ← مهلة 3 أيام ← قراءة فقط. حماية من إرجاع الساعة وكود أقدم.
// «قراءة فقط»: العرض والتقارير والنسخ تبقى ويتوقف التسجيل. لا تُحذف بيانات أبداً.

/** المفتاح العام (SPKI بصيغة base64): للتحقق فقط، والمفتاح السري عند صاحب البرنامج وحده. */
export const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAHgzIibL68CKarDAGP/3cNFZ7J1jjzNYSpsvtwdkQ2kg=';

export const WARN_DAYS = 7;
export const GRACE_DAYS = 3;
const DAY = 86400000;
const CLOCK_TOLERANCE = 36 * 3600000;
export const PLANS = { basic: 'الأساسية', messages: 'بالرسائل', full: 'المتكاملة' };
/** ما تتيحه كل باقة */
export const FEATURES = {
  basic: { sync: false, whatsapp: false },
  messages: { sync: true, whatsapp: true },
  full: { sync: true, whatsapp: true },
};

/** @param {string} s @returns {Uint8Array} */
export function b64uBytes(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** المفتاح العام الخام (32 بايت) من صيغة SPKI. */
export const rawPublicKey = () => b64uBytes(PUBLIC_KEY_B64).slice(-32);

/**
 * @typedef {(msg: Uint8Array, sig: Uint8Array) => boolean} Verify
 * @typedef {{raw: string, machine: string, issued: string, issuedAt: number, services: Record<string, {expires: string, expiresAt: number, plan: string, pack: string}>, shopKey: string}} Parsed
 */

/**
 * @param {string} code
 * @param {{verify: Verify, machine: string}} o
 * @returns {Parsed}
 */
export function parseCode(code, o) {
  const c = String(code || '').replace(/\s+/g, '');
  const [p, s] = c.split('.');
  if (!p || !s) throw new Error('صيغة الكود غير صحيحة');
  /** @type {any} */ let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64uBytes(p))); } catch { throw new Error('صيغة الكود غير صحيحة'); }
  let ok = false;
  try { ok = !!o.verify(new TextEncoder().encode(p), b64uBytes(s)); } catch { /* غير صالح */ }
  if (!ok) throw new Error('الكود غير صالح (التوقيع لا يطابق)');
  if (payload.m !== o.machine) throw new Error('هذا الكود لجهاز آخر — رمز هذا الجهاز: ' + o.machine);
  const raw = payload.s && typeof payload.s === 'object' ? payload.s : { ajel: { e: payload.e, p: payload.p } };
  /** @type {Parsed['services']} */
  const services = {};
  for (const key of Object.keys(raw)) {
    const sv = raw[key] || {};
    const exp = Date.parse(String(sv.e) + 'T23:59:59');
    if (!exp) continue;
    services[key] = { expires: sv.e, expiresAt: exp, plan: sv.p || '', pack: sv.k in PLANS ? sv.k : 'basic' };
  }
  if (!Object.keys(services).length) throw new Error('الكود لا يحتوي أي خدمة صالحة');
  const issuedAt = Number(payload.t) || Date.parse((payload.i || '1970-01-01') + 'T00:00:00') || 0;
  const shopKey = typeof payload.sk === 'string' ? payload.sk : '';
  return { raw: c, machine: payload.m, issued: payload.i || '', issuedAt, services, shopKey };
}

/** @param {number} n */
function daysAr(n) {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومين';
  if (n >= 3 && n <= 10) return n + ' أيام';
  return n + ' يوماً';
}

/**
 * مدير اشتراك دفتر الأجل على جهاز واحد.
 * @param {object} o
 * @param {Verify} o.verify
 * @param {string} o.machine رمز الجهاز
 * @param {{get: () => any, set: (patch: any) => void}} o.storage تخزين متزامن لحالة الاشتراك {code,maxIssued,lastSeen}
 * @param {() => string[]} [o.extraCodes] أكواد من أماكن أخرى (المجلد المشترك على الكمبيوتر)
 * @param {(code: string) => void} [o.onAccepted]
 * @param {() => number} [o.now]
 * @param {string} [o.app]
 */
export function createLicenseManager({ verify, machine, storage, extraCodes = () => [], onAccepted = () => {}, now = () => Date.now(), app = 'ajel' }) {
  const popts = { verify, machine };
  function stored() {
    const f = storage.get() || {};
    return { lastSeen: Number(f.lastSeen) || 0, maxIssued: Number(f.maxIssued) || 0, code: f.code || '' };
  }
  /** @param {string[]} codes */
  function newestValid(codes) {
    /** @type {Parsed | null} */ let best = null;
    for (const c of codes) {
      if (!c) continue;
      try { const p = parseCode(c, popts); if (!best || p.issuedAt > best.issuedAt) best = p; } catch { /* تجاهل */ }
    }
    return best;
  }

  function status() {
    const t = now();
    const st = stored();
    let clockBack = false;
    if (st.lastSeen && t < st.lastSeen - CLOCK_TOLERANCE) clockBack = true;
    else if (!st.lastSeen || t > st.lastSeen + 60000) storage.set({ lastSeen: Math.max(t, st.lastSeen) });
    const base = { machineCode: machine, app, plans: PLANS };
    if (clockBack) {
      return { ...base, licensed: false, state: 'readonly', reason: 'clock', pack: 'basic', features: FEATURES.basic, message: 'تاريخ الجهاز غير صحيح (أقدم من آخر استخدام). صحّح التاريخ والوقت ليعمل البرنامج.' };
    }
    const best = newestValid([st.code].concat(extraCodes()));
    if (best && best.issuedAt >= st.maxIssued) {
      if (best.raw !== st.code || best.issuedAt > st.maxIssued) storage.set({ code: best.raw, maxIssued: best.issuedAt });
    }
    const lic = best && best.issuedAt >= st.maxIssued ? best : null;
    if (!lic) {
      const rolledBack = !!best && best.issuedAt < st.maxIssued;
      return { ...base, licensed: false, state: 'readonly', reason: 'unlicensed', pack: 'basic', features: FEATURES.basic, message: rolledBack ? 'أدخل آخر كود تفعيل وصلك من مزوّد البرنامج.' : 'البرنامج غير مفعّل — أدخل كود التفعيل للبدء.' };
    }
    const sv = lic.services[app];
    if (!sv) {
      return { ...base, licensed: false, state: 'readonly', reason: 'not-included', pack: 'basic', features: FEATURES.basic, message: 'خدمة دفتر الأجل غير مشمولة في الاشتراك الحالي — تواصل مع مزوّد البرنامج.' };
    }
    const days = Math.ceil((sv.expiresAt - t) / DAY);
    const trial = /^trial/.test(sv.plan);
    const out = { ...base, licensed: true, keyFromCode: !!lic.shopKey && sv.pack !== 'basic', trial, expires: sv.expires, plan: sv.plan, pack: sv.pack, packLabel: PLANS[/** @type {'basic'} */ (sv.pack)], features: FEATURES[/** @type {'basic'} */ (sv.pack)], daysLeft: days };
    const what = trial ? 'الفترة التجريبية' : 'الاشتراك';
    const ends = trial ? 'تنتهي' : 'ينتهي', ended = trial ? 'انتهت' : 'انتهى';
    if (days > WARN_DAYS) return { ...out, state: 'active', message: '' };
    if (days >= 0) return { ...out, state: 'warning', message: `${what} ${ends} ${days === 0 ? 'اليوم' : 'خلال ' + daysAr(days)} — أدخل كود تفعيل جديد حتى لا يتوقف التسجيل.` };
    if (days >= -GRACE_DAYS) return { ...out, state: 'grace', message: `${ended} ${what} — متبقٍ ${daysAr(GRACE_DAYS + days + 1)} قبل أن يتوقف التسجيل. أدخل كود تفعيل جديداً.` };
    return { ...out, state: 'readonly', reason: 'expired', message: `${ended} ${what} — البرنامج في وضع القراءة فقط. أدخل كود تفعيل جديداً للاستئناف.` };
  }

  /** مفتاح البقالة داخل أحدث كود صالح (فارغ للأساسية أو إن لم يوجد). لا يُعرض في الواجهة. */
  function shopKey() {
    const st = stored();
    const best = newestValid([st.code].concat(extraCodes()));
    return best && best.issuedAt >= st.maxIssued && best.services[app] && best.services[app].pack !== 'basic' ? best.shopKey : '';
  }
  /** كود الاشتراك الصالح الحالي (لإرساله للسيرفر مع المزامنة)؛ فارغ للأساسية أو إن لم يوجد. */
  function rawCode() {
    const st = stored();
    const best = newestValid([st.code].concat(extraCodes()));
    return best && best.issuedAt >= st.maxIssued && best.services[app] && best.services[app].pack !== 'basic' ? best.raw : '';
  }
  const isReadOnly = () => { try { return status().state === 'readonly'; } catch { return false; } };
  /** هل يُسمح بالتسجيل؟ @returns {{ok: boolean, message: string}} */
  const canWrite = () => { const s = status(); return s.state === 'readonly' ? { ok: false, message: s.message } : { ok: true, message: '' }; };

  /** @param {string} code */
  function activate(code) {
    const lic = parseCode(code, popts);
    const st = stored();
    if (lic.issuedAt < st.maxIssued) throw new Error('هذا الكود أقدم من الكود المفعّل حالياً — أدخل آخر كود وصلك.');
    /** @type {any} */ const patch = { code: lic.raw, maxIssued: Math.max(lic.issuedAt, st.maxIssued) };
    if (lic.raw !== st.code) patch.lastSeen = now();
    storage.set(patch);
    onAccepted(lic.raw);
    return lic;
  }
  return { status, isReadOnly, canWrite, activate, shopKey, rawCode };
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** رمز جهاز عشوائي للجوال (بنفس شكل رمز الكمبيوتر ABCD-1234). @param {Uint8Array} rnd 8 بايت على الأقل */
export function randomDeviceCode(rnd) {
  let s = '';
  for (let i = 0; i < 8; i++) s += B32[rnd[i] & 31];
  return s.slice(0, 4) + '-' + s.slice(4);
}
