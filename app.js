// تطبيق دفتر الأجل على الجوال (الوضع الأول): بدون سيرفر، كل البيانات على الجهاز.
// القلب (packages/core) يحسب كل شيء من سجل العمليات، وهذا الملف واجهة فقط.
import {
  Ledger, LedgerError, isFrozenNow, effectiveCap, toHalalas, formatMoney, shortId,
  statement, debtTable, analyticsSummary, eventsLog, waNumber, waSettings, shopInfo, waStamp, remSettings, remPlan, remDue, riyadhParts, waMessage as coreWaMessage, waReminder,
} from './core/index.js';
import * as db from './db.js';
import * as lock from './lock.js';
import { scanSupported, scanOnce } from './scan.js';
import { SyncClient, verifyKey, SYNC_URL, notifyStatus, claimManual, linkStatus, linkRequest, driveCall } from './sync.js';
import qrcode from './vendor/qrcode.js';

const VERSION = '0.2.0';
const RELOCK_MS = 5 * 60 * 1000;

/** @type {Ledger} */
let ledger;
const meta = { deviceId: '', lockEnabled: false, credId: null, ownerRequired: false, ownerPin: null, theme: 'auto', lastBackupAt: 0, syncOn: false, syncKey: '', syncCursor: 0, syncLastAt: 0, syncPushed: /** @type {Set<string>} */ (new Set()) };
const saved = new Set();
let locked = false;
let hiddenAt = 0;
const ui = { accOpen: /** @type {Record<string, boolean>} */ ({}), syncSetup: false, syncKeyPending: '', addOpen: false, rec: null, cust: { all: false }, editOk: null, addPrefill: '', debtQ: '', remConfirm: false, remOpen: false, frz: 'open', linkMode: 'code', linkPhone: '', linkAsked: 0, drvAsked: 0, drvConfirm: false };

const $app = /** @type {HTMLElement} */ (document.getElementById('app'));
$app.innerHTML = '<div id="v"></div><div id="ov"></div>';
const $v = /** @type {HTMLElement} */ (document.getElementById('v'));
const $ov = /** @type {HTMLElement} */ (document.getElementById('ov'));

// ===== أدوات عرض =====
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toLatin = (v) => v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
const fmt = (h) => (h / 100).toLocaleString('en-US', { minimumFractionDigits: h % 100 ? 2 : 0, maximumFractionDigits: 2 });
const KIND = { purchase: 'شراء', payment: 'تسديد', return: 'مرتجع', opening: 'رصيد سابق' };
const PILL = { purchase: 'buy', payment: 'pay', return: 'ret', opening: 'open' };
const dayFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const signed = (t) => (t.kind === 'purchase' || t.kind === 'opening' ? '' : '-') + fmt(t.amount);

function balHtml(c) {
  if (c.balance > 0) return `<span class="num owe">${fmt(c.balance)}</span>`;
  if (c.balance < 0) return `<span class="num pos">له ${fmt(-c.balance)}</span>`;
  return '<span class="num">0</span>';
}

// ===== واتساب: اليدوي والاحتياط للتلقائي =====
// الإعدادات تُحفظ كعمليات في الدفتر (تتزامن بين الجوالات والجسر): wa.on / wa.auto / wa.shop / wa.bal / wa.last
let waShopTimer = 0;
/** @param {HTMLInputElement} t */
function saveShop(t) {
  const key = t.id === 'shopNameIn' ? 'shop.name' : 'shop.phone';
  const v = toLatin(t.value.trim());
  const cur = shopInfo(ledger.state.settings);
  if (v !== (key === 'shop.name' ? cur.name : cur.phone)) { ledger.setSetting(key, key === 'shop.name' ? t.value.trim() : v); flush(); }
}
const waCfg = () => waSettings(ledger.state.settings);
async function setWa(key, value) { ledger.setSetting(key, value); await flush(); render(); }
/** نص الرسالة للعميل (بدون اسمه): الرصيد وآخر عملية واسم البقالة حسب الإعدادات */
function waMessage(cid) {
  const c = ledger.customer(cid);
  const s = ledger.state;
  const last = [...c.txnIds].reverse().map((id) => s.txns.get(id)).find((x) => x && !x.voided && x.kind !== 'opening');
  return coreWaMessage(s, cid, last || null);
}
/** حالة الجسر الآن (يُحدَّث بعد كل مزامنة وقبل قرار الإرسال) */
const bridge = { alive: false, at: 0, /** @type {{op: string, status: string, at: number}[]} */ items: [] };
async function refreshBridge() {
  if (!meta.syncOn || !meta.syncKey) { bridge.alive = false; return null; }
  const st = await Promise.race([notifyStatus(SYNC_URL, meta.syncKey, (u, i) => fetch(u, i)), new Promise((r) => setTimeout(() => r(null), 2500))]);
  bridge.alive = !!(st && st.bridge && st.bridge.alive); bridge.at = Date.now();
  if (st && Array.isArray(st.items)) bridge.items = st.items;
  return st;
}
function waSheet(cid, tid = '') {
  const c = ledger.customer(cid);
  if (!c || !c.phone) { toast('لا يوجد رقم جوال لهذا العميل'); return; }
  const s = ledger.state;
  const w = waCfg();
  const rem = tid ? null : waReminder(s, cid); // بدون عملية = «تذكير بالرصيد»
  const msg = rem ? rem.text : waMessage(cid);
  const t = (tid && s.txns.get(tid)) || [...c.txnIds].reverse().map((id) => s.txns.get(id)).find((x) => x && !x.voided && x.kind !== 'opening') || null;
  const KL = { purchase: ['مشترياتك بالآجل', 'var(--buy)'], payment: ['تسديدك', 'var(--pay)'], return: ['مرتجعك', 'var(--ret)'] };
  const kl = !rem && t && w.last ? KL[t.kind] : null;
  const [d, tm] = (rem ? rem.stamp : waStamp(t ? t.ts : Date.now())).split(/\u00A0+-\u00A0+/);
  const bal = !rem && w.bal ? (c.balance > 0 ? `رصيدك الحالي : ${fmt(c.balance)} ريال` : c.balance < 0 ? `لك عندنا : ${fmt(-c.balance)} ريال` : 'حسابك مسدّد') : '';
  const remHtml = rem ? `<div class="kind">${rem.state === 'debt' ? 'رصيدكم للمشتريات الأجلة' : rem.state === 'credit' ? 'لكم عندنا' : 'حسابكم مسدّد'}</div>${rem.state === 'zero' ? '' : `<div class="amt" style="color:${rem.state === 'debt' ? 'var(--pay)' : 'var(--buy)'}">${fmt(rem.amount)}<small>ريال</small></div>`}${rem.lines.slice(rem.state === 'zero' ? 1 : 1).map((l) => `<div class="tag">${esc(l)}</div>`).join('')}` : '';
  const el = sheet(`<div class="grab"></div>
    <div class="nwhead"><span class="av">${esc([...c.name][0] || '؟')}</span><div class="who"><b>${esc(c.name)}</b><small dir="ltr">${esc(c.phone)}</small></div><span class="chip">${ic('chat')}واتساب</span></div>
    <div class="receipt" id="waRc">${w.shop ? `<div class="shop">${esc(w.shop)}</div>` : ''}${remHtml}${kl ? `<div class="kind">${kl[0]}</div><div class="amt" style="color:${kl[1]}">${fmt(t.amount)}<small>ريال</small></div>` : ''}${bal ? `<div class="kind">${esc(bal)}</div>` : ''}<div class="when"><bdi>${esc(d)}</bdi><i></i><bdi>${esc(tm || '')}</bdi></div></div>
    <textarea id="waText" class="rtx" hidden rows="${msg.split('\n').length}" aria-label="نص الرسالة">${esc(msg)}</textarea>
    <button type="button" class="editlink" data-act="wa-edit">${ic('edit')}<span>تعديل النص</span></button>
    <button type="button" class="gobtn" data-act="wa-go" data-cid="${c.id}" data-tid="${tid}">${ic('chat')}إرسال عبر واتساب</button>
    <button type="button" class="nocancel" data-act="close-ov">إلغاء</button>
    <div class="tag center">لا يُرسل شيء إلا بضغطك «إرسال» داخل واتساب</div>`);
  el.classList.add('nwa');
}
/** بعد حفظ عملية: لو الجسر حيّ ننتظر إرساله وإلا تظهر الورقة اليدوية فوراً */
async function afterSaveWa(cid, tid) {
  const cfg = waCfg();
  const c = ledger.customer(cid);
  if (!c || !c.phone || c.waOff) return;
  let auto = false;
  if (cfg.auto && meta.syncOn) { await refreshBridge(); auto = bridge.alive; }
  if (!auto) { if (cfg.on) window.setTimeout(() => waSheet(cid, tid), 1600); return; } // بعد أن تختفي بطاقة «تم الحفظ»
  schedSync(100);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await notifyStatus(SYNC_URL, meta.syncKey, (u, x) => fetch(u, x));
    const it = st && st.items.find((/** @type {any} */ x) => x.op === tid);
    if (it && it.status === 'sent') { bigToast('#128c4a', '#fff', 'chat', 'أُرسلت الرسالة للعميل ✓', `${c.name} · واتساب`, 2400); return; }
    if (it && it.status === 'failed') break;
  }
  if (cfg.on) { bigToast('var(--pay)', 'var(--pay-ink)', 'clock', 'تعذّر الإرسال التلقائي', 'اضغط «فتح واتساب» لإرسالها بنفسك', 2200); window.setTimeout(() => waSheet(cid, tid), 2300); } else bigToast('var(--pay)', 'var(--pay-ink)', 'clock', 'لم تُرسل الرسالة', 'تعذّر الإرسال التلقائي للعميل', 2600);
}

// رسالة تطمين بعد حفظ العملية: وسط الشاشة بلون العملية وتختفي وحدها
/** بطاقة تطمين كبيرة وسط الشاشة: دائرة أيقونة + عنوان كبير + سطر تفصيل، وتختفي وحدها */
function bigToast(bg, fg, icon, title, line, ms = 1500) {
  document.querySelector('.savedtoast')?.remove();
  const el = document.createElement('div');
  el.className = 'savedtoast';
  el.innerHTML = `<div style="background:${bg};color:${fg}"><i>${ic(icon)}</i><b>${esc(title)}</b><span>${esc(line)}</span></div>`;
  el.querySelector('i').style.setProperty('--ic', fg);
  $app.appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}
// بعد حفظ العملية: بلون العملية
function savedToast(kind, line) {
  const v = { purchase: 'buy', payment: 'pay', return: 'ret' }[kind] || 'buy';
  bigToast(`var(--${v})`, `var(--${v}-ink)`, 'check', `تم حفظ ${KIND[kind] || 'العملية'}`, line);
}
let toastTimer = 0;
function toast(msg, ms = 2800) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $app.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), ms);
}

function applyTheme() {
  const r = document.documentElement;
  if (meta.theme === 'light' || meta.theme === 'dark') r.setAttribute('data-theme', meta.theme);
  else r.removeAttribute('data-theme');
}

// ===== التخزين =====
async function flush() {
  const fresh = ledger.allOps().filter((op) => !saved.has(op.id));
  await db.putOps(fresh);
  for (const op of fresh) saved.add(op.id);
  if (fresh.length) schedSync();
}

// ===== المزامنة مع السيرفر =====
const syncStore = {
  getCursor: () => meta.syncCursor,
  setCursor: async (/** @type {number} */ n) => { meta.syncCursor = n; await db.setMeta('syncCursor', n); },
  getPushed: () => meta.syncPushed,
  addPushed: async (/** @type {string[]} */ ids) => { for (const id of ids) meta.syncPushed.add(id); await db.setMeta('syncPushed', [...meta.syncPushed]); },
};
/** @type {SyncClient | null} */
let syncClient = null;
let syncTimer = 0;

function startSync() {
  syncClient = null;
  if (!meta.syncOn || !meta.syncKey) return;
  syncClient = new SyncClient({
    baseUrl: SYNC_URL, key: meta.syncKey, ledger, store: syncStore,
    fetchFn: (u, i) => fetch(u, i),
    onPulled: async () => {
      await flush();
      // لا نعيد رسم الشاشة والمستخدم يكتب في خانة، حتى لا يضيع ما كتبه
      const a = document.activeElement;
      if (!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'))) render();
    },
  });
}

let drvAt = 0;
async function runSync() {
  if (!syncClient || locked) return;
  const st = await syncClient.sync();
  if (st === 'idle') { meta.syncLastAt = syncClient.lastSyncAt; await db.setMeta('syncLastAt', meta.syncLastAt); }
  if (location.hash.startsWith('#/settings')) await refreshBridge();
  if (st === 'idle' && Date.now() - drvAt > 600000) { drvAt = Date.now(); if (await refreshDrive() && (location.hash.startsWith('#/home') || location.hash === '#/')) render(); }
  if (location.hash.startsWith('#/settings') && !ui.syncSetup) render();
  return st;
}

function schedSync(delay = 1500) {
  clearTimeout(syncTimer);
  if (syncClient) syncTimer = window.setTimeout(runSync, delay);
}

// ===== هيكل الصفحة =====
const NAV = [['home', 'home', 'الرئيسية'], ['debts', 'list', 'الديون'], ['reports', 'chart', 'التقارير'], ['settings', 'gear', 'الإعدادات']];

/** عناصر قائمة ⋮ للشاشة الحالية (لا قائمة = لا زر ⋮) */
let curMenu = /** @type {{i: string, l: string, d: string, cid?: string}[]} */ ([]);
function page({ title, back = '', body, nav = '', extra = '', style = '', sub = '', menu = /** @type {{i: string, l: string, d: string, cid?: string}[]} */ ([]) }) {
  curMenu = menu;
  const navHtml = nav ? `<nav class="nav">${NAV.map(([r, i, l]) => `<a href="#/${r}" class="${nav === r ? 'on' : ''}">${ic(i)}${l}</a>`).join('')}</nav>` : '';
  const top = `<div class="top">${back ? `<button class="back" data-act="back" data-to="${back}" aria-label="رجوع">${ic('back')}</button>` : ''}${title}${extra}
      ${menu.length ? `<button class="dotsbtn" data-act="menu" aria-label="القائمة">${ic('dots')}</button>` : ''}</div>`;
  return `<div class="pg" style="${style}">
    ${sub ? `<div class="rechead">${top}${sub}</div>` : top}
    ${body}${navHtml}</div>`;
}

// ===== الشاشات =====
// نتائج البحث: الصف يفتح التسجيل، وزر "السجل" يفتح كشف الحساب
function customerRows(list) {
  return list.map((c) => `<div class="card row"><a class="nm" href="#/record/${c.id}" style="flex:1;color:inherit;text-decoration:none"><b>${esc(c.name)}</b><small>رقم ${c.codeNo}</small></a>${balHtml(c)}<a class="pill open histbtn" href="#/customer/${c.id}">السجل</a></div>`).join('');
}

// آخر العمليات في الرئيسية (بدون أرصدة): كل صف يفتح حساب العميل
function recentOpsHtml() {
  const s = ledger.state;
  const list = [...s.txns.values()].filter((t) => !t.voided && t.kind !== 'opening' && s.customers.has(t.cid))
    .sort((a, b) => b.ts - a.ts).slice(0, 12);
  if (!list.length) return '';
  const today = new Date().toDateString();
  return `<div class="tag">آخر العمليات</div>` + list.map((t) => {
    const d = new Date(t.ts);
    const when = (d.toDateString() === today ? 'اليوم ' : dayFmt.format(d) + ' ') + timeFmt.format(d);
    return `<a class="card row ops" href="#/customer/${t.cid}"><div class="nm"><b>${esc(s.customers.get(t.cid).name)}</b><small>${when}</small></div><span class="pill ${PILL[t.kind]}">${KIND[t.kind]}</span><span class="num">${fmt(t.amount)}</span></a>`;
  }).join('');
}

function resultsHtml(q) {
  if (!q.trim()) {
    if (!ledger.state.customers.size) return `<div class="card center stack"><div>لا يوجد عملاء بعد</div><a class="btn main" href="#/add">${ic('user-plus')}إضافة أول عميل</a></div>`;
    return recentOpsHtml() || '<div class="card center tag">ابحث عن عميل أو امسح بطاقته لتسجيل عملية</div>';
  }
  const list = ledger.search(q);
  if (!list.length) return `<div class="card center stack"><div>لا يوجد عميل بهذا الاسم أو الرقم</div><button class="btn" data-act="add-from-search">${ic('user-plus')}إضافة عميل جديد</button></div>`;
  return customerRows(list);
}

function viewHome() {
  const sub = `<div class="herosearch"><div class="field big-field">${ic('search')}<input id="q" type="search" inputmode="search" autocomplete="off" placeholder="ابحث بالرقم أو الاسم" aria-label="بحث"><button type="button" class="scanbtn" data-act="scan" aria-label="مسح بطاقة العميل">${ic('scan')}</button></div>
    <div id="numpad" class="numpad">${['1', '2', '3', '4', '5', '⌫', '6', '7', '8', '9', '0'].map((k) => `<button type="button" data-act="np" data-k="${k}"${k === '⌫' ? ' class="del" aria-label="مسح"' : ''}>${k}</button>`).join('')}</div></div>`;
  const dw = driveWarnDays();
  const warn = dw ? `<a class="card" href="#/settings" style="display:block;border-color:var(--pay);color:inherit;text-decoration:none"><b style="color:var(--pay)">${ic('lock')} تعذّر حفظ نسخة Google Drive منذ ${dw === 1 ? 'يوم' : dw + ' أيام'}</b><div class="tag">افتح الإعدادات ثم المزامنة والنسخ الاحتياطي لإصلاح الربط.</div></a>` : '';
  const body = `<div class="body">${warn}<div id="results" class="stack">${resultsHtml('')}</div></div>`;
  return page({ title: 'الرئيسية', body, nav: 'home', sub });
}

function viewRecord(cid) {
  const c = ledger.state.customers.get(cid);
  if (!c) return viewMissing();
  if (!ui.rec || ui.rec.cid !== cid) ui.rec = { cid, kind: 'purchase', amt: '' };
  const k = ui.rec.kind;
  const v = { purchase: 'buy', payment: 'pay', return: 'ret' }[k];
  const kinds = [['purchase', 'cart', 'شراء'], ['payment', 'pay', 'تسديد'], ['return', 'ret', 'مرتجع']]
    .map(([id, i, l]) => `<button data-act="kind" data-k="${id}" aria-pressed="${k === id}">${ic(i)}${l}</button>`).join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((x) => `<button data-act="key" data-k="${x}">${x}</button>`).join('');
  const sub = `<a class="recinfo" href="#/customer/${c.id}"><div class="nm"><b>${esc(c.name)}</b><small>رقم ${c.codeNo} · الرصيد الحالي</small></div>${balHtml(c)}</a>
    <div class="kinds">${kinds}</div>`;
  const body = `<div class="body" style="gap:10px">
    <div class="big" id="amt">${esc(ui.rec.amt || '0')}</div>
    <div class="keys">${keys}</div>
    <button class="save" data-act="save">حفظ</button></div>`;
  return page({ title: 'تسجيل عملية', back: '#/home', nav: '-', sub, body, style: `--kind:var(--${v});--kind-ink:var(--${v}-ink)` });
}

/** نص شارة الإيقاف */
function frozenText(c) {
  const f = c.freeze;
  if (!f) return '';
  if (f.untilPaid) return 'موقوف الآجل · حتى يسدّد';
  if (f.until) return `موقوف الآجل · حتى ${dayFmt.format(f.until)}`;
  return 'موقوف الآجل';
}

function viewCustomer(cid) {
  const s = ledger.state;
  const c = s.customers.get(cid);
  if (!c) return viewMissing();
  const st = statement(s, cid, { cycleOnly: !ui.cust.all });
  const days = [...st.days].reverse().map((d) => `<div class="day">${dayFmt.format(d.date)}</div>` +
    [...d.rows].reverse().map(({ txn: t, after }) => `<button class="card row ops" style="width:100%;text-align:inherit;cursor:pointer" data-act="txn" data-tid="${t.id}">
      <span class="tag">${timeFmt.format(t.ts)}${t.note ? ' · ' + esc(t.note) : ''}</span><span class="pill ${PILL[t.kind]}">${KIND[t.kind]}</span>
      <span class="num">${signed(t)}<small>${fmt(after)}</small></span></button>`).join('')).join('');
  const sub = `<div class="center herobox"><b style="font-size:20px">${esc(c.name)}</b>
      <div class="tag">رقم ${c.codeNo}${c.phone ? ' · ' + esc(c.phone) : ''}</div>
      <div class="big ${c.balance > 0 ? 'owe' : c.balance < 0 ? 'pos' : ''}">${c.balance < 0 ? 'له ' : ''}${fmt(Math.abs(c.balance))}</div>
      <div class="tag">${ui.cust.all ? 'كل الحركات' : 'المستحق منذ آخر تصفية'}</div>
      ${isFrozenNow(c, Date.now()) ? `<div class="frzb">${ic('lock')}${esc(frozenText(c))}</div>` : ''}
      <div class="actrow"><a class="actic main" href="#/record/${c.id}" aria-label="تسجيل عملية"><span>${ic('cart')}</span><small>تسجيل عملية</small></a>
      ${waCfg().on && c.phone ? `<button class="actic wa" data-act="wa-open" data-cid="${c.id}" aria-label="تذكير بالرصيد"><span>${ic('chat')}</span><small>تذكير بالرصيد</small></button>` : ''}</div></div>`;
  const body = `<div class="body">
    ${days || '<div class="card center tag">لا توجد حركات بعد</div>'}</div>`;
  const menu = [
    { i: 'print', l: 'طباعة', d: 'print' },
    { i: 'share', l: 'مشاركة', d: 'share' },
    { i: 'list', l: ui.cust.all ? 'الدورة الحالية' : 'عرض الكل', d: 'toggle-all' },
    { i: 'gear', l: 'تعديل البيانات', d: 'edit' },
    isFrozenNow(c, Date.now()) ? { i: 'lock', l: 'إعادة الآجل', d: 'unfreeze' } : { i: 'lock', l: 'إيقاف الآجل', d: 'freeze-open' },
  ].map((m) => ({ ...m, cid: c.id }));
  return page({ title: 'حساب العميل', back: '#/home', nav: '-', sub, body, menu });
}

function viewAdd() {
  const hasContacts = 'contacts' in navigator && 'ContactsManager' in window;
  const body = `<div class="body"><form id="addForm" class="stack" autocomplete="off">
    <div class="form"><label for="f-name">اسم العميل</label><input id="f-name" required value="${esc(ui.addPrefill)}"></div>
    <div class="form"><label for="f-phone">رقم الجوال (اختياري)</label>
      <div class="input-row"><input id="f-phone" type="tel" inputmode="tel" dir="ltr" style="text-align:right">${hasContacts ? `<button type="button" class="btn" data-act="pick-contact" style="padding:0 12px" aria-label="من جهات الاتصال">${ic('contacts')}</button>` : ''}</div></div>
    <div class="form"><label for="f-open">رصيد سابق من الدفتر الورقي (اختياري)</label><input id="f-open" inputmode="decimal" dir="ltr" style="text-align:right"></div>
    <div id="formErr"></div>
    <button class="btn main" type="submit">حفظ العميل</button></form>
    ${hasContacts ? '' : '<div class="tag center">اختيار العميل من جهات الاتصال يعمل على كروم في أندرويد.</div>'}</div>`;
  ui.addPrefill = '';
  return page({ title: 'إضافة عميل', back: '#/settings', nav: 'settings', body });
}

function viewEdit(cid) {
  const c = ledger.state.customers.get(cid);
  if (!c) return viewMissing();
  if (ui.editOk !== cid) { location.hash = `#/customer/${cid}`; return ''; }
  const body = `<div class="body"><form id="editForm" class="stack" data-cid="${c.id}" autocomplete="off">
    <div class="form"><label for="f-name">اسم العميل</label><input id="f-name" required value="${esc(c.name)}"></div>
    <div class="form"><label for="f-phone">رقم الجوال</label><input id="f-phone" type="tel" inputmode="tel" dir="ltr" style="text-align:right" value="${esc(c.phone || '')}"></div>
    <div class="form"><label for="f-cap">سقف خاص لهذا العميل بالريال (اختياري)</label><input id="f-cap" inputmode="decimal" dir="ltr" style="text-align:right" placeholder="فارغ = السقف العام" value="${c.cap ? fmt(c.cap).replace(/,/g, '') : ''}"></div>
    <label class="sw" for="f-wa"><span>إشعار واتساب تلقائي لهذا العميل</span><input id="f-wa" type="checkbox" ${c.waOff ? '' : 'checked'} style="width:22px;height:22px"></label>
    <div class="tag">كل تعديل يُسجَّل في الأحداث ويمكن الرجوع عنه.</div>
    <div id="formErr"></div>
    <button class="btn main" type="submit">حفظ التعديل</button></form></div>`;
  return page({ title: 'تعديل العميل', back: `#/customer/${cid}`, nav: '-', body });
}

function viewDebts() {
  const now = Date.now();
  const rows = debtTable(ledger.state, now, 'debt');
  const total = rows.reduce((a, r) => a + r.customer.balance, 0);
  const q = ui.debtQ.trim();
  const shown = q ? rows.filter((r) => ledger.search(q, { limit: 500 }).some((c) => c.id === r.customer.id)) : rows;
  const list = shown.map((r) => `<a class="card row" href="#/customer/${r.customer.id}"><div class="nm"><b>${esc(r.customer.name)}</b><small>${r.days === 0 ? 'آخر حركة اليوم' : `منذ ${r.days} يوم`}</small></div><span class="num owe">${fmt(r.customer.balance)}</span></a>`).join('');
  const sub = `<div class="herosearch"><div class="field big-field">${ic('search')}<input id="dq" type="search" autocomplete="off" placeholder="ابحث في الجدول" value="${esc(ui.debtQ)}"><a class="addbtn" href="#/add" aria-label="إضافة عميل جديد">${ic('plus')}</a></div></div>`;
  const body = `<div class="body">
    ${list || '<div class="card center tag">لا توجد ديون حالياً</div>'}</div>`;
  return page({ title: 'جدول الديون', body, sub, nav: 'debts', extra: `<span class="sp"></span><span class="tag">المجموع</span><span class="num owe">${fmt(total)}</span>` });
}

function viewReports() {
  const now = Date.now();
  const s = ledger.state;
  const a = analyticsSummary(s, now);
  const top = debtTable(s, now, 'debt').slice(0, 10);
  const late = debtTable(s, now, 'overdue30');
  const sub = `<div class="stat herostat"><div class="card"><div class="tag">إجمالي الديون</div><div class="num owe" style="font-size:24px">${fmt(a.totalOutstanding)}</div><div class="tag">${a.customersWithDebt} عميل</div></div>
      <div class="card"><div class="tag">المسدد هذا الشهر</div><div class="num" style="font-size:24px;color:var(--pay)">${fmt(a.collectedMonth)}</div><div class="tag">شراء جديد ${fmt(a.newDebtMonth)}</div></div></div>`;
  const body = `<div class="body">
    <div class="card"><b>أكبر المدينين</b>${top.length ? top.map((r, i) => `<a class="row rank" href="#/customer/${r.customer.id}"><span class="rk">${i + 1}</span><span class="nm2">${esc(r.customer.name)}</span><span class="num">${fmt(r.customer.balance)}</span></a>`).join('') : '<div class="tag">لا ديون</div>'}</div>
    <div class="card stack"><div class="row"><b>المتأخرون</b><span class="pill">أكثر من 30 يوماً</span></div>
      ${late.length ? late.map((r) => `<div class="row"><span>${esc(r.customer.name)}</span><span class="num owe">${fmt(r.customer.balance)}</span></div>`).join('') : '<div class="tag">لا يوجد متأخرون</div>'}</div></div>`;
  return page({ title: 'التقارير', body, sub, nav: 'reports' });
}

const tgl = (act, on) => `<button class="tg" role="switch" aria-checked="${on}" data-act="${act}"><i></i></button>`;

const SYNC_MSG = {
  syncing: ['جارٍ المزامنة...', ''],
  offline: ['لا يوجد إنترنت: ستُرسل العمليات عند عودته', 'warn'],
  unauthorized: ['المفتاح غير صالح. اطلب مفتاحاً جديداً من إدارة الخدمة', 'bad'],
  disabled: ['الخدمة موقوفة لهذه البقالة', 'bad'],
  error: ['تعذّر الاتصال بالسيرفر، سنحاول لاحقاً', 'warn'],
};

/** بطاقة إعدادات مطوية: صف واحد (أيقونة + اسم + حالة) وتنفتح بالضغط */
function acc(id, icon, title, status, inner) {
  const open = !!ui.accOpen[id];
  return `<div class="acc${open ? ' open' : ''}"><button type="button" class="acchead" data-act="acc" data-id="${id}" aria-expanded="${open}"><span class="ai">${ic(icon)}</span><span class="at"><b>${title}</b><small>${status}</small></span>${ic('back')}</button>${open ? `<div class="ab">${inner}</div>` : ''}</div>`;
}

const dsec = (/** @type {string} */ t) => `<div class="dsec">${t}</div>`;

/** حالة ربط واتساب كما يراها السيرفر (يحدّثها الجسر) */
const link = { state: 'unlinked', phone: /** @type {string | null} */ (null), req: /** @type {any} */ (null), qr: /** @type {string | null} */ (null), code: /** @type {string | null} */ (null), bridgeAlive: false, ok: false, err: "" };
let linkTimer = 0;
async function refreshLink() {
  if (!meta.syncOn || !meta.syncKey) { link.ok = false; return false; }
  const l = await linkStatus(SYNC_URL, meta.syncKey, (u, i) => fetch(u, i));
  if (!l || 'error' in l) { link.ok = false; link.err = l && 'error' in l ? l.error : 'net'; return false; }
  link.err = '';
  const before = JSON.stringify(link);
  Object.assign(link, { state: l.state, phone: l.phone, req: l.req, qr: l.qr, code: l.code, bridgeAlive: l.bridgeAlive, ok: true });
  return JSON.stringify(link) !== before;
}
/** نتابع الحالة كل 3 ثوانٍ ما دامت بطاقة الواتساب مفتوحة في الإعدادات */
function startLinkPoll() {
  if (linkTimer) return;
  linkTimer = window.setInterval(async () => {
    if (route()[0] !== 'settings' || !ui.accOpen.wa || document.hidden) { clearInterval(linkTimer); linkTimer = 0; return; }
    const typing = document.activeElement && document.activeElement.id === 'linkPhone';
    if (await refreshLink() && !typing) render();
  }, 3000);
}
// ===== نسخ Google Drive (يرفعها السيرفر تلقائياً إلى حساب صاحب البقالة) =====
const drv = { ok: false, err: '', busy: false, /** @type {any} */ d: null };
async function refreshDrive() {
  if (!meta.syncOn || !meta.syncKey) { drv.ok = false; drv.d = null; return false; }
  const r = await driveCall(SYNC_URL, meta.syncKey, 'GET', 'status', (u, i) => fetch(u, i));
  const before = JSON.stringify(drv);
  if (r.error) { drv.ok = false; drv.err = r.error; } else { drv.ok = true; drv.err = ''; drv.d = r; }
  return JSON.stringify(drv) !== before;
}
let drvTimer = 0;
/** بعد فتح نافذة Google: نتابع الحالة كل 3 ثوانٍ (حتى 5 دقائق) لنعرض «تم الربط» فور عودة صاحب البقالة */
function startDrivePoll() {
  if (drvTimer) return;
  drvTimer = window.setInterval(async () => {
    const waiting = ui.drvAsked > 0 && Date.now() - ui.drvAsked < 300000;
    if (!waiting || route()[0] !== 'settings' || document.hidden) { clearInterval(drvTimer); drvTimer = 0; if (!waiting) ui.drvAsked = 0; return; }
    if (await refreshDrive() && drv.d && drv.d.linked) { ui.drvAsked = 0; render(); toast('✓ تم ربط Google Drive'); }
  }, 3000);
}
/** تنبيه الصفحة الرئيسية: فشل حفظ النسخة يوماً كاملاً أو أكثر */
function driveWarnDays() {
  const d = drv.d;
  if (!drv.ok || !d || !d.linked || !d.failSince) return 0;
  const days = Math.floor((Date.now() - d.failSince) / 86400000);
  return days >= 1 ? days : 0;
}
function driveHtml() {
  if (!meta.syncOn) return '<div class="tag">يحتاج تفعيل «المزامنة مع السيرفر» أولاً.</div>';
  if (!drv.ok && drv.err) return `<div class="tag" style="color:var(--pay)">تعذّر التحقق من السيرفر (${esc(drv.err === 'net' ? 'لا اتصال' : 'رمز ' + drv.err)}).</div><button class="btn" data-act="drive-retry">إعادة المحاولة</button>`;
  if (!drv.ok) return '<div class="tag">جارٍ التحقق...</div>';
  const d = drv.d;
  if (!d.configured) return '<div class="tag">نسخ Google Drive غير مفعّل على السيرفر بعد.</div>';
  if (ui.drvAsked > 0 && Date.now() - ui.drvAsked < 300000 && !d.linked) return '<div class="tag center">أكمل الموافقة في نافذة Google، ثم ارجع هنا...</div><button class="btn" data-act="drive-cancel">إلغاء</button>';
  const btn = (/** @type {string} */ act, /** @type {string} */ label) => `<button class="btn main" data-act="${act}">${ic('save')}${label}</button>`;
  if (!d.linked) {
    return `<div class="tag">يحفظ السيرفر نسخة من دفترك في Google Drive الخاص بك تلقائياً. يرى مجلد «دفتر الأجل» فقط ولا يرى بقية ملفاتك.</div>${btn('drive-link', 'ربط Google Drive')}`;
  }
  const bad = d.failSince > 0;
  const head = d.state === 'error'
    ? `<div class="lkok" style="border-color:var(--pay)">${ic('lock')}<div><b style="color:var(--pay)">انتهى ربط Google Drive</b><div class="tag">أعد الربط لتستمر النسخ.</div></div></div>${btn('drive-link', 'إعادة الربط')}`
    : bad
      ? `<div class="lkok" style="border-color:var(--pay)">${ic('lock')}<div><b style="color:var(--pay)">تعذّر حفظ النسخة منذ ${fullFmt.format(d.failSince)}</b><div class="tag">سنعيد المحاولة تلقائياً. إن استمر الفشل أعد الربط.</div></div></div>`
      : `<div class="lkok">${ic('check')}<div><b>مربوط · <span dir="ltr">${esc(d.email || '')}</span></b><div class="tag">${d.lastOk ? 'آخر نسخة: ' + fullFmt.format(d.lastOk) : 'جارٍ تجهيز أول نسخة...'}</div></div></div>`;
  const off = ui.drvConfirm
    ? `<div class="tag">يتوقف حفظ النسخ الجديدة. تبقى النسخ الحالية في Drive. هل تريد الفصل؟</div><div class="two"><button class="btn" data-act="drive-unlink-no">إلغاء</button><button class="btn" data-act="drive-unlink-yes">نعم، افصل</button></div>`
    : `<div class="two"><button class="btn" data-act="drive-now" ${drv.busy ? 'disabled' : ''}>${drv.busy ? 'جارٍ النسخ...' : 'انسخ الآن'}</button><button class="btn" data-act="drive-unlink">فصل الربط</button></div>`;
  return `${head}<div class="tag">نسخة جديدة كل يوم، تُحفظ آخر ${d.keepDays || 30} يوماً ثم تُحذف الأقدم تلقائياً.</div>${off}`;
}

function waLinkHtml() {
  if (!meta.syncOn) return '<div class="tag">يحتاج تفعيل «المزامنة مع السيرفر» أولاً (في بطاقة المزامنة بالأسفل).</div>';
  if (!link.ok && link.err) return `<div class="tag" style="color:var(--pay)">تعذّر التحقق من السيرفر (${esc(link.err === 'net' ? 'لا اتصال' : 'رمز ' + link.err)}).</div><button class="btn" data-act="link-retry">إعادة المحاولة</button>`;
  if (!link.ok) return '<div class="tag">جارٍ التحقق من حالة الربط...</div>';
  const stepsOf = (/** @type {string[]} */ a) => `<div class="lksteps">${a.map((t, i) => `<div><b>${i + 1}</b><span>${t}</span></div>`).join('')}</div>`;
  if (link.state === 'linked') {
    return `<div class="lkok">${ic('check')}<div><b>مربوط برقم <span dir="ltr">${esc(link.phone || '')}</span></b><div class="tag">${link.bridgeAlive ? 'الجسر شغّال ويرسل' : 'الجسر غير متصل الآن: تُستعمل الأزرار اليدوية'}</div></div></div>
      <button class="btn" data-act="link-off">${ic('lock')}فصل الربط</button>`;
  }
  if (link.state === 'waiting' && (link.code || link.qr)) {
    let main = '';
    if (link.code) main = `<div class="lkcode" dir="ltr">${[...link.code.slice(0, 4)].map((c) => `<span>${esc(c)}</span>`).join('')}<i>-</i>${[...link.code.slice(4)].map((c) => `<span>${esc(c)}</span>`).join('')}</div>`;
    else if (link.qr) { const q = qrcode(0, 'L'); q.addData(link.qr); q.make(); main = `<div class="lkqr">${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>`; }
    return `${main}<div class="tag center">${link.code ? 'الرمز صالح دقائق قليلة' : 'يتجدد الرمز تلقائياً كل نحو 20 ثانية'}</div>
      ${stepsOf(link.code ? ['افتح واتساب في جوال البقالة', 'اضغط ⋮ ثم «الأجهزة المرتبطة» ثم «ربط جهاز»', 'اختر «الربط برقم الهاتف بدلاً من ذلك»', 'اكتب الرمز أعلاه'] : ['اعرض هذه الشاشة على جهاز آخر (جوال أو كمبيوتر)', 'في واتساب جوال البقالة: ⋮ ثم «الأجهزة المرتبطة» ثم «ربط جهاز»', 'وجّه كاميرا الجوال إلى الرمز لتمسحه'])}
      <button class="btn" data-act="link-cancel">إلغاء</button>`;
  }
  const preparing = (link.req && link.req.mode !== 'unlink') || (Date.now() - ui.linkAsked < 40000 && ui.linkAsked > 0);
  if (preparing) return '<div class="tag center">جارٍ تجهيز الرمز من الجسر... لحظات</div><button class="btn" data-act="link-cancel">إلغاء</button>';
  const code = ui.linkMode === 'code';
  return `<div class="tag">لإرسال رسائل العملاء تلقائياً من رقم البقالة، اربط واتساب البقالة مرة واحدة.</div>
    <div class="kinds" style="grid-template-columns:1fr 1fr"><button type="button" data-act="link-mode" data-m="code" aria-pressed="${code}">بالرمز (من نفس الجوال)</button><button type="button" data-act="link-mode" data-m="qr" aria-pressed="${!code}">بالـQR (من جهاز آخر)</button></div>
    ${code ? `<label class="tag" for="linkPhone">رقم واتساب البقالة</label><input id="linkPhone" class="keyin" type="tel" inputmode="tel" dir="ltr" style="text-align:right" autocomplete="off" placeholder="05xxxxxxxx" value="${esc(ui.linkPhone)}">` : ''}
    ${link.bridgeAlive ? '' : '<div class="tag" style="color:var(--pay)">الجسر غير متصل الآن، شغّله أولاً ثم أعد المحاولة.</div>'}
    <button class="btn main" data-act="link-go" ${link.bridgeAlive ? '' : 'disabled'}>${ic('chat')}${code ? 'احصل على رمز الربط' : 'اعرض رمز الـQR'}</button>`;
}

function syncCardHtml() {
  const open = meta.syncOn || ui.syncSetup;
  let inner = `<div class="tag">مطفأة افتراضياً. يبقى التطبيق يعمل كاملاً بدونها.</div>`;
  if (ui.syncSetup && !meta.syncOn) {
    inner = `<div class="stack"><input id="syncKeyInput" class="keyin" dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="مفتاح البقالة">
      <div class="tag">الصق المفتاح الذي استلمته من إدارة الخدمة.</div>
      <button class="btn main" data-act="sync-link">ربط</button></div>`;
  } else if (meta.syncOn) {
    const st = syncClient ? syncClient.state : 'idle';
    const m = SYNC_MSG[st];
    const last = (syncClient && syncClient.lastSyncAt) || meta.syncLastAt;
    const pending = syncClient ? syncClient.pending() : 0;
    inner = `<div class="stack">
      <div class="row"><span class="tag">الحالة</span>${m ? `<span class="syncst ${m[1]}">${m[0]}</span>` : '<span class="pos" style="font-weight:700">متصل ✓</span>'}</div>
      <div class="row"><span class="tag">آخر مزامنة</span><span>${last ? fullFmt.format(last) : 'لم تتم بعد'}</span></div>
      <div class="row"><span class="tag">بانتظار الإرسال</span><span class="num">${pending} عملية</span></div>
      <button class="btn" data-act="sync-now">${ic('save')}مزامنة الآن</button>
      <button class="btn" data-act="sync-change">${ic('gear')}تغيير مفتاح البقالة</button>
      <div class="tag">عند انقطاع الإنترنت تُحفظ العمليات في الجوال وتُرسل عند عودته.</div></div>`;
  }
  const stTxt = meta.syncOn ? (syncClient && SYNC_MSG[syncClient.state] ? 'مفعّلة' : 'متصل ✓') : 'مطفأة';
  return { status: stTxt, inner: `<div class="sw"><div><span>نسخة احتياطية تلقائية، وتزامن بين الجوالات</span></div>${tgl('toggle-sync', open)}</div>${inner}` };
}

function waCardHtml() {
  const w = waCfg();
  const inner = `<div class="stack">
      <div class="sw"><span>الإرسال التلقائي بعد كل عملية (يحتاج الجسر)</span>${tgl('toggle-wa-auto', w.auto)}</div>
      <div class="sw"><span>أزرار الواتساب اليدوية (احتياط)</span>${tgl('toggle-wa', w.on)}</div>
      <div class="sw"><span>تضمين الرصيد</span>${tgl('toggle-wa-bal', w.bal)}</div>
      <div class="sw"><span>تضمين آخر عملية</span>${tgl('toggle-wa-last', w.last)}</div>
      <div class="tag">${meta.syncOn ? (bridge.alive ? 'الجسر شغّال ✓' : 'الجسر غير متصل الآن: تُستعمل الأزرار اليدوية') : 'يحتاج تفعيل المزامنة مع السيرفر'}</div>
      <div class="tag">لإيقاف الإشعار لعميل معيّن: تعديل بيانات العميل.</div></div>`;
  return { status: w.auto ? 'تلقائي' : w.on ? 'يدوي' : 'مطفأة', inner };
}

function shopCardHtml() {
  const sh = shopInfo(ledger.state.settings);
  const inner = `<div class="stack">
      <label class="tag" for="shopNameIn">اسم البقالة</label>
      <input id="shopNameIn" class="keyin" style="text-align:start" autocomplete="off" placeholder="مثال: بقالة الأمل" value="${esc(sh.name)}">
      <div class="tag">يظهر في أول سطر من رسالة الواتساب للعميل.</div>
      <label class="tag" for="shopPhoneIn">رقم هاتف البقالة</label>
      <input id="shopPhoneIn" class="keyin" type="tel" inputmode="tel" dir="ltr" style="text-align:right" autocomplete="off" placeholder="05xxxxxxxx" value="${esc(sh.phone)}">
      <div class="tag">يظهر في كشف الحساب المطبوع فقط.</div></div>`;
  return { status: sh.name ? esc(sh.name) : 'لم يُدخل بعد', inner };
}

function remCardHtml() {
  const r = remSettings(ledger.state.settings);
  const plan = remPlan(ledger.state);
  const total = plan.reduce((a, p) => a + p.balance, 0);
  const h12 = (r.hour % 12 || 12) + ':00 ' + (r.hour < 12 ? 'ص' : 'م');
  const step = (what, label, val) => `<div class="mset"><span>${label}</span><div class="mstep"><button type="button" data-act="rem-step" data-k="${what}" data-d="-1" aria-label="أنقص">−</button><b>${val}</b><button type="button" data-act="rem-step" data-k="${what}" data-d="1" aria-label="زِد">+</button></div></div>`;
  // آخر دفعة تذكير من سجل الجسر (rem-<مفتاح الدفعة>-<عميل>)
  const items = bridge.items.filter((x) => x.op.startsWith('rem-'));
  let lastTxt = '';
  if (items.length) {
    const keyOf = (/** @type {string} */ op) => op.slice(4, op.lastIndexOf('-'));
    const newest = items.reduce((a, b) => (b.at > a.at ? b : a));
    const grp = items.filter((x) => keyOf(x.op) === keyOf(newest.op));
    const ok = grp.filter((x) => x.status === 'sent').length;
    const bad = grp.filter((x) => x.status === 'failed').length;
    lastTxt = `آخر تذكير: ${fullFmt.format(newest.at)} · أُرسل ${ok}${bad ? ` وفشل ${bad}` : ''}`;
  }
  const t = riyadhParts(Date.now());
  const monthKey = `${t.y}${String(t.m).padStart(2, '0')}`;
  const missed = r.on && t.d > r.day && !items.some((x) => x.op.startsWith(`rem-${monthKey}-`));
  const inner = `<div class="sw"><span>إرسال تذكير بالرصيد تلقائياً كل شهر</span>${tgl('toggle-rem', r.on)}</div>
    ${r.on || ui.remOpen ? `<div class="stack">
      ${step('day', 'يوم الشهر', String(r.day))}
      ${step('hour', 'الساعة', h12)}
      ${step('min', 'لا ترسل لمن رصيده أقل من', fmt(r.min) + ' ريال')}
      <div class="mset"><span>الفاصل بين الرسائل</span><b class="tag">30 ثانية (حماية الرقم)</b></div>
      <div class="mprev"><div class="tag">معاينة: يوم ${r.day} الساعة ${h12}</div>
        <div class="mbig"><b>${plan.length}</b><span>${plan.length === 1 ? 'عميل سيصله التذكير' : 'عميلاً سيصلهم التذكير'}${plan.length ? ` · مجموع ${fmt(total)} ريال` : ''}</span></div>
        <div class="mlist">${plan.slice(0, 3).map((p) => `<div><span>${esc(p.name)}</span><b class="owe">${fmt(p.balance)}</b></div>`).join('')}${plan.length > 3 ? `<div class="tag">... و${plan.length - 3} آخرين · المدة التقريبية ${Math.max(1, Math.round(plan.length / 2))} دقيقة</div>` : ''}</div></div>
      ${lastTxt ? `<div class="mlast">${ic('check')}<span>${lastTxt}</span></div>` : ''}
      ${missed ? '<div class="tag" style="color:var(--pay)">لم يُرسل تذكير هذا الشهر (فات موعده). تأكد أن الجسر شغّال، أو أرسله الآن.</div>' : ''}
      <div class="tag">يحتاج الجسر شغّالاً. لو كان متوقفاً في ذلك اليوم يرسل عند عودته، وإن فات اليوم يظهر لك تنبيه هنا. لا يصل التذكير للمسدّدين ولا لمن له رصيد عندنا ولا لمن أطفأت له الإشعار. لا تتكرر الرسالة للعميل في نفس الشهر.</div>
      <button class="btn" data-act="rem-now" ${plan.length ? '' : 'disabled'}>${ic('chat')}${ui.remConfirm ? `اضغط للتأكيد: إرسال لـ ${plan.length} عميل الآن` : 'إرسال التذكير الآن للجميع (مرة واحدة)'}</button></div>` : ''}`;
  return { status: r.on ? `يوم ${r.day} من كل شهر` : 'مطفأ', inner };
}

function viewSettings() {
  const shop = shopCardHtml(); const wa = waCardHtml(); const rem = remCardHtml(); const sy = syncCardHtml();
  const capOn = !!ledger.state.settings.capEnabled;
  const evCount = eventsLog(ledger.allOps()).length;
  const lastB = meta.lastBackupAt ? fullFmt.format(meta.lastBackupAt) : 'لم تؤخذ نسخة بعد';
  const hasContacts = 'contacts' in navigator && 'ContactsManager' in window;
  const open = !!ui.addOpen;
  const sub = `<div class="addhero"><button type="button" class="addtoggle" data-act="toggle-add" aria-expanded="${open}"><span>${ic('user-plus')}إضافة عميل جديد</span>${ic('back')}</button>
    ${open ? `<form id="addForm" class="addform" autocomplete="off">
    <input id="f-name" required placeholder="اسم العميل" aria-label="اسم العميل">
    <div class="two-in"><div class="phonebox"><input id="f-phone" type="tel" inputmode="tel" dir="ltr" style="text-align:right" placeholder="رقم الهاتف" aria-label="رقم الهاتف">${hasContacts ? `<button type="button" class="inbtn" data-act="pick-contact" aria-label="من جهات الاتصال">${ic('contacts')}</button>` : ''}</div>
    <input id="f-open" inputmode="decimal" dir="ltr" style="text-align:right" placeholder="الرصيد السابق" aria-label="الرصيد السابق"></div>
    <div id="formErr"></div>
    <button class="save" type="submit">حفظ العميل</button></form>` : ''}</div>`;
  const body = `<div class="body">
    ${acc('shop', 'home', 'بيانات البقالة', shop.status, shop.inner + dsec('المظهر') + `<div class="two3">${[['auto', 'auto', 'تلقائي'], ['light', 'sun', 'نهاري'], ['dark', 'moon', 'ليلي']].map(([k, i, l]) => `<button class="btn${meta.theme === k ? ' sel' : ''}" data-act="theme" data-t="${k}" aria-pressed="${meta.theme === k}">${ic(i)}${l}</button>`).join('')}</div>`)}
    ${acc('sec', 'lock', 'الأمان والتحكم', `${meta.lockEnabled ? 'قفل مفعّل' : 'القفل مطفأ'} · ${capOn ? 'سقف مفعّل' : 'السقف مطفأ'}`,
      `<div class="sw"><span>قفل التطبيق (بصمة الجوال أو رمز فتحه)</span>${tgl('toggle-lock', meta.lockEnabled)}</div>
      <div class="tag">مطفأ افتراضياً، فيفتح التطبيق مباشرة.</div>
      <div class="sw"><span>رمز صاحب البقالة لعكس العمليات وتعديل العملاء</span>${tgl('toggle-owner', meta.ownerRequired)}</div>
      <div class="tag">مطفأ افتراضياً. كل عكس أو تعديل يُسجَّل في الأحداث حتى لو كان الرمز مطفأً. احفظ الرمز جيداً.</div>
      ${dsec('سقوف الدين')}
      <div class="sw"><span>تفعيل سقف الدين</span>${tgl('toggle-cap', capOn)}</div>
      ${capOn ? `<div class="mset"><span>السقف العام لكل عميل</span><div class="mstep"><button type="button" data-act="cap-step" data-d="-1" aria-label="أنقص">−</button><b>${fmt(Number(ledger.state.settings.globalCap || 0))} ريال</b><button type="button" data-act="cap-step" data-d="1" aria-label="زِد">+</button></div></div>` : ''}
      <div class="tag">مطفأ افتراضياً. يسري على كل عميل ليس له سقف خاص (يُحدَّد من «تعديل بيانات العميل»). عند تجاوزه يظهر تنبيه عند تسجيل الشراء. وإيقاف الآجل لعميل من قائمة ⋮ في حسابه.</div>`)}
    ${acc('wa', 'chat', 'الواتساب', (link.ok && link.state === 'linked' ? 'مربوط ✓ · ' : '') + wa.status, dsec('الربط') + waLinkHtml() + dsec('الرسائل') + wa.inner + dsec('التذكير الشهري') + rem.inner)}
    ${acc('sync', 'save', 'المزامنة والنسخ الاحتياطي', sy.status + (drv.ok && drv.d && drv.d.linked ? (drv.d.state === 'error' || drv.d.failSince ? ' · Drive ⚠' : ' · Drive ✓') : ''), dsec('المزامنة مع السيرفر') + sy.inner + dsec('نسخة احتياطية') + `<div class="two"><button class="btn" data-act="backup">${ic('share')}إرسال عبر واتساب</button><button class="btn" data-act="restore">${ic('save')}استرجاع</button></div>
      <input id="restoreFile" type="file" accept=".json,application/json" hidden>
      <div class="tag">آخر نسخة: ${lastB}</div>
      <div class="tag" id="persistTag">التخزين الدائم: ...</div>` + dsec('Google Drive') + driveHtml())}
    <a class="acc" href="#/events" style="text-decoration:none;color:inherit"><span class="acchead"><span class="ai">${ic('clock')}</span><span class="at"><b>الأحداث</b><small>${evCount ? evCount + ' حدث (عكس وتعديل وإيقاف واستثناءات)' : 'لا توجد أحداث بعد'}</small></span>${ic('back')}</span></a>
    <div class="tag center">دفتر الأجل ${VERSION} · الجهاز ${esc(meta.deviceId)}</div></div>`;
  return page({ title: 'الإعدادات', body, sub, nav: 'settings' });
}

function viewEvents() {
  const s = ledger.state;
  const name = (cid) => esc(s.customers.get(cid)?.name || '—');
  const fieldName = { name: 'الاسم', phone: 'الجوال', cap: 'السقف' };
  const val = (f, v) => (v == null ? 'فارغ' : f === 'cap' ? fmt(v) : esc(v));
  const list = eventsLog(ledger.allOps()).map((e) => {
    if (e.type === 'txn.void') return `<div class="card stack"><div class="row"><b>عكس ${KIND[e.kind]} ${fmt(e.amount)}</b><span class="pill">عكس</span></div>
      <div class="tag">${name(e.cid)} · ${fullFmt.format(e.ts)}${e.reason ? ' · ' + esc(e.reason) : ''}</div>
      <button class="btn" data-act="redo" data-id="${e.id}">${ic('undo')}إعادة تسجيلها</button></div>`;
    if (e.type === 'txn.exception') return `<div class="card stack"><div class="row"><b>استثناء: ${KIND[e.kind]} ${fmt(e.amount)}</b><span class="pill pay">استثناء</span></div><div class="tag">${name(e.cid)} · ${fullFmt.format(e.ts)}</div></div>`;
    if (e.type === 'customer.freeze') return `<div class="card stack"><div class="row"><b>${e.frozen ? 'إيقاف الآجل' : 'إعادة الآجل'} ${name(e.cid)}</b><span class="pill">إيقاف</span></div><div class="tag">${fullFmt.format(e.ts)}${e.frozen ? (e.untilPaid ? ' · حتى يسدّد' : e.until ? ' · حتى ' + dayFmt.format(e.until) : '') : ''}</div></div>`;
    if (e.type === 'customer.update') return `<div class="card stack"><div class="row"><b>تعديل بيانات ${name(e.cid)}</b><span class="pill">تعديل</span></div>
      ${e.changes.map((c) => `<div class="tag">${fieldName[c.field]}: ${val(c.field, c.from)} ← ${val(c.field, c.to)}</div>`).join('')}
      <div class="tag">${fullFmt.format(e.ts)}</div>
      <button class="btn" data-act="restore-edit" data-id="${e.id}">${ic('undo')}استرجاع القيم السابقة</button></div>`;
    return `<div class="card stack"><div class="row"><b>${e.archived ? 'أرشفة' : 'إلغاء أرشفة'} ${name(e.cid)}</b><span class="pill">أرشفة</span></div><div class="tag">${fullFmt.format(e.ts)}</div></div>`;
  }).join('');
  const body = `<div class="body">${list || '<div class="card center tag">لا توجد أحداث بعد</div>'}</div>`;
  return page({ title: 'الأحداث', back: '#/settings', nav: 'settings', body });
}

function viewMissing() {
  return page({ title: 'غير موجود', back: '#/home', nav: '-', body: '<div class="body"><div class="card center">لم نجد هذا العميل</div></div>' });
}

function viewLock() {
  return `<div class="lockscreen"><div>${ic('finger').replace('class="ic"', 'class="ic" style="width:56px;height:56px;stroke-width:1.4"')}</div>
    <b>دفتر الأجل (مقفل)</b><div class="tag center">يظهر طلب بصمة الجوال أو رمز فتحه نفسه</div>
    <button class="btn main" data-act="unlock" style="width:100%">${ic('finger')}فتح بقفل الجوال</button></div>`;
}

// ===== التوجيه =====
function route() {
  const [name = 'home', arg = ''] = location.hash.replace(/^#\//, '').split('/');
  return [name || 'home', arg];
}

function render() {
  if (!ledger) return;
  if (locked) { $v.innerHTML = viewLock(); return; }
  const [name, arg] = route();
  let html;
  switch (name) {
    case 'record': html = viewRecord(arg); break;
    case 'customer': html = viewCustomer(arg); break;
    case 'add': html = viewAdd(); break;
    case 'edit': html = viewEdit(arg); break;
    case 'debts': html = viewDebts(); break;
    case 'reports': html = viewReports(); break;
    case 'settings': html = viewSettings(); break;
    case 'events': html = viewEvents(); break;
    default: html = viewHome();
  }
  $v.innerHTML = html;
  if (name === 'settings') db.persistenceStatus().then((p) => {
    const el = document.getElementById('persistTag');
    if (el) el.textContent = 'التخزين الدائم: ' + ({ granted: 'مفعّل', denied: 'غير مفعّل (قد يمسح الجوال البيانات عند ضيق المساحة)', unsupported: 'غير مدعوم' }[p]);
  });
}

// ===== النوافذ =====
function sheet(html, vars = '', centered = false) {
  $ov.innerHTML = `<div class="sheet${centered ? ' mid' : ''}" style="${vars}"><div>${html}</div></div>`;
  return /** @type {HTMLElement} */ ($ov.firstElementChild);
}
const closeOv = () => { $ov.innerHTML = ''; };

/** نافذة رمز من 4 أرقام. ترجع الرمز أو null عند الإلغاء. */
function askPin(title) {
  return new Promise((resolve) => {
    let pin = '';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => `<button data-k="${k}" class="${k ? '' : 'blank'}">${k}</button>`).join('');
    const el = sheet(`<div class="center"><b>${esc(title)}</b></div><div class="dots">${'<i></i>'.repeat(4)}</div><div class="keys">${keys}</div><div class="two" style="grid-template-columns:1fr"><button data-k="cancel">إلغاء</button></div>`);
    const dots = () => el.querySelectorAll('.dots i').forEach((d, i) => d.classList.toggle('f', i < pin.length));
    el.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!b) return;
      const k = b.dataset.k;
      if (k === 'cancel') { closeOv(); resolve(null); return; }
      if (k === '⌫') pin = pin.slice(0, -1);
      else if (k && pin.length < 4) pin += k;
      dots();
      if (pin.length === 4) { const v = pin; closeOv(); resolve(v); }
    });
  });
}

/** يطلب رمز صاحب البقالة إن كان الخيار مفعّلاً. */
async function requireOwner() {
  if (!meta.ownerRequired) return true;
  const pin = await askPin('رمز صاحب البقالة');
  if (pin == null) return false;
  if (await lock.checkPin(pin, meta.ownerPin)) return true;
  toast('الرمز غير صحيح');
  return false;
}

// ===== عمليات =====
const ERR = {
  'name-required': 'اكتب اسم العميل',
  'duplicate-name': 'يوجد عميل بنفس الاسم',
  'duplicate-phone': 'يوجد عميل بنفس رقم الجوال',
  archived: 'هذا العميل مؤرشف',
  'bad-amount': 'المبلغ غير صحيح',
  'needs-approval': 'العميل موقوف أو تجاوز السقف',
};

async function saveRecord(approve = false) {
  const r = ui.rec;
  if (!r) return;
  const amount = toHalalas(r.amt);
  if (!amount) { toast('أدخل مبلغاً'); return; }
  try {
    const fn = { purchase: 'purchase', payment: 'payment', return: 'ret' }[r.kind];
    const res = ledger[fn](r.cid, amount, r.kind === 'purchase' && approve ? { approve: true } : undefined);
    await flush();
    const c = ledger.customer(r.cid);
    savedToast(r.kind, `${KIND[r.kind]} ${fmt(amount)} · ${c.name}`);
    ui.rec = null;
    location.hash = '#/home';
    // الجسر حيّ: ننتظر إرساله ونتنبه لو فشل. وإلا ورقة الرسالة اليدوية فوراً
    afterSaveWa(r.cid, res.txn.id);
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'needs-approval') { approvalDialog(r.cid, amount); return; }
    toast(e instanceof LedgerError ? (ERR[e.code] || e.code) : 'تعذّر الحفظ');
  }
}

/** عميل موقوف أو الشراء يتجاوز السقف: موافق = استثناء يُسجَّل، إلغاء = لا يُسجَّل شيء */
function approvalDialog(cid, amount) {
  const c = ledger.customer(cid);
  const chk = ledger.checkPurchase(cid, amount);
  const lines = [];
  if (chk.frozen) lines.push(`${esc(c.name)} ${esc(frozenText(c))}.`);
  if (chk.overCap) lines.push(`الرصيد بعد الشراء <b>${fmt(chk.after)}</b> من أصل سقف <b>${fmt(chk.cap)}</b>.`);
  const title = chk.frozen ? 'هذا العميل موقوف الآجل' : 'هذا الشراء يتجاوز سقف العميل';
  sheet(`<div class="apv"><span class="apic">${ic('lock')}</span><b class="aptt">${title}</b>
    <div class="apbd">${lines.join('<br>')}<br>هل تريد تسجيل الشراء كاستثناء؟</div>
    <div class="two"><button class="btn" data-act="apv-no">إلغاء العملية</button><button class="btn apyes" data-act="apv-yes">موافق، استثناء</button></div>
    <div class="tag center">«موافق» تُسجَّل العملية كاستثناء في سجل الأحداث. «إلغاء» لا يُسجَّل شيء.</div></div>`, '', true);
}

function showFormError(e, retry) {
  const box = document.getElementById('formErr');
  if (!box) return;
  const msg = e instanceof LedgerError ? (ERR[e.code] || e.code) : 'تعذّر الحفظ';
  const dup = e instanceof LedgerError && e.details.customer;
  box.innerHTML = `<div class="err">${esc(msg)}${dup ? `: ${esc(e.details.customer.name)} (رقم ${e.details.customer.codeNo})` : ''}</div>` +
    (dup ? '<button type="button" class="btn" id="forceBtn" style="margin-top:8px;width:100%">حفظ رغم التكرار</button>' : '');
  document.getElementById('forceBtn')?.addEventListener('click', retry);
}

async function submitAdd(force = false) {
  const name = /** @type {HTMLInputElement} */ (document.getElementById('f-name')).value;
  const phone = /** @type {HTMLInputElement} */ (document.getElementById('f-phone')).value;
  const open = /** @type {HTMLInputElement} */ (document.getElementById('f-open')).value;
  const opening = open.trim() ? toHalalas(open) : null;
  if (open.trim() && !opening) { toast('الرصيد السابق غير صحيح'); return; }
  try {
    const { customer } = ledger.addCustomer({ name, phone, opening, force });
    await flush();
    toast(`✓ أُضيف ${customer.name} برقم ${customer.codeNo}`);
    location.hash = `#/customer/${customer.id}`;
  } catch (e) { showFormError(e, () => submitAdd(true)); }
}

async function submitEdit(cid, force = false) {
  const name = /** @type {HTMLInputElement} */ (document.getElementById('f-name')).value;
  const phone = /** @type {HTMLInputElement} */ (document.getElementById('f-phone')).value;
  try {
    const waOff = !(/** @type {HTMLInputElement} */ (document.getElementById('f-wa'))).checked;
    const capIn = /** @type {HTMLInputElement} */ (document.getElementById('f-cap')).value.trim();
    const capH = capIn ? toHalalas(capIn) : null; // فارغ أو 0 = بلا سقف خاص
    if (capIn && capIn !== '0' && !capH) { toast('السقف غير صحيح'); return; }
    ledger.updateCustomer(cid, { name, phone, waOff, cap: capH || null, force });
    await flush();
    ui.editOk = null;
    toast('✓ تم حفظ التعديل');
    location.hash = `#/customer/${cid}`;
  } catch (e) { showFormError(e, () => submitEdit(cid, true)); }
}

function statementText(cid) {
  const s = ledger.state;
  const c = s.customers.get(cid);
  if (!c) return '';
  const st = statement(s, cid);
  const lines = [`كشف حساب: ${c.name} (رقم ${c.codeNo})`, `الرصيد: ${c.balance < 0 ? 'له ' : ''}${fmt(Math.abs(c.balance))} ريال`, ''];
  for (const d of st.days) {
    lines.push(dayFmt.format(d.date));
    for (const { txn: t } of d.rows) lines.push(`  ${KIND[t.kind]} ${signed(t)} (${timeFmt.format(t.ts)})`);
  }
  return lines.join('\n');
}

async function shareStatement(cid) {
  const text = statementText(cid);
  try {
    if (navigator.share) await navigator.share({ title: 'كشف حساب', text });
    else window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  } catch { /* أُلغيت المشاركة */ }
}

function printStatement(cid) {
  const s = ledger.state;
  const c = s.customers.get(cid);
  if (!c) return;
  const st = statement(s, cid);
  const rows = st.days.map((d) => `<tr><th colspan="4">${dayFmt.format(d.date)}</th></tr>` +
    d.rows.map(({ txn: t, after }) => `<tr><td>${KIND[t.kind]}</td><td>${timeFmt.format(t.ts)}</td><td dir="ltr">${signed(t)}</td><td dir="ltr">${fmt(after)}</td></tr>`).join('')).join('');
  const sh = shopInfo(s.settings);
  document.getElementById('printArea').innerHTML = `${sh.name || sh.phone ? `<p><b>${esc(sh.name)}</b>${sh.phone ? ` · <span dir="ltr">${esc(sh.phone)}</span>` : ''}</p>` : ''}<h2>كشف حساب: ${esc(c.name)} (رقم ${c.codeNo})</h2>
    <p>الرصيد: ${c.balance < 0 ? 'له ' : ''}${fmt(Math.abs(c.balance))} ريال · ${dayFmt.format(Date.now())}</p>
    <table><tr><th>العملية</th><th>الوقت</th><th>المبلغ</th><th>الرصيد</th></tr>${rows}</table>`;
  window.print();
}

async function backup() {
  const stamp = new Date().toISOString().slice(0, 10);
  const json = JSON.stringify({ app: 'daftar', v: 1, exportedAt: Date.now(), device: meta.deviceId, ops: ledger.allOps() });
  const file = new File([json], `daftar-backup-${stamp}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'نسخة دفتر الأجل' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    meta.lastBackupAt = Date.now();
    await db.setMeta('lastBackupAt', meta.lastBackupAt);
    toast('✓ تم تجهيز النسخة الاحتياطية');
    render();
  } catch (e) {
    if (!(e && e.name === 'AbortError')) toast('تعذّر تجهيز النسخة');
  }
}

async function restoreFrom(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || obj.app !== 'daftar' || !Array.isArray(obj.ops)) throw new Error('bad');
    const r = ledger.merge(obj.ops);
    await flush();
    toast(`✓ تمت إضافة ${r.added.length} عملية${r.rejected ? ` (رُفضت ${r.rejected})` : ''}. لم يُحذف شيء.`, 4500);
    render();
  } catch { toast('الملف ليس نسخة دفتر الأجل صحيحة'); }
}

async function toggleLock() {
  if (meta.lockEnabled) {
    if (!(await lock.unlockWithDevice(meta.credId))) { toast('لم يتم التحقق'); return; }
    meta.lockEnabled = false; meta.credId = null;
    await db.setMeta('lockEnabled', false); await db.delMeta('credId');
    toast('تم إيقاف قفل التطبيق');
  } else {
    if (!(await lock.deviceLockAvailable())) { toast('جوالك بلا بصمة أو رمز فتح. فعّل قفل الشاشة من إعدادات الجوال أولاً.', 4500); return; }
    const id = await lock.enableDeviceLock();
    if (!id) { toast('لم يتم التفعيل'); return; }
    meta.lockEnabled = true; meta.credId = id;
    await db.setMeta('lockEnabled', true); await db.setMeta('credId', id);
    toast('✓ تم تفعيل قفل التطبيق');
  }
  render();
}

async function toggleOwner() {
  if (meta.ownerRequired) {
    const pin = await askPin('الرمز الحالي');
    if (pin == null) return;
    if (!(await lock.checkPin(pin, meta.ownerPin))) { toast('الرمز غير صحيح'); return; }
    meta.ownerRequired = false; meta.ownerPin = null;
    await db.setMeta('ownerRequired', false); await db.delMeta('ownerPin');
    toast('تم إيقاف رمز صاحب البقالة');
  } else {
    const a = await askPin('رمز جديد (4 أرقام)');
    if (a == null) return;
    const b = await askPin('أعد كتابة الرمز');
    if (b == null) return;
    if (a !== b) { toast('الرمزان غير متطابقين'); return; }
    meta.ownerPin = await lock.hashPin(a);
    meta.ownerRequired = true;
    await db.setMeta('ownerPin', meta.ownerPin); await db.setMeta('ownerRequired', true);
    toast('✓ تم تفعيل رمز صاحب البقالة');
  }
  render();
}

async function tryUnlock() {
  if (await lock.unlockWithDevice(meta.credId)) { locked = false; render(); } else toast('لم يتم التحقق');
}

async function doScan() {
  if (!scanSupported()) { toast('المسح بالكاميرا غير مدعوم على هذا الجوال. استخدم البحث بالرقم أو الاسم.', 4500); return; }
  let code = null;
  try { code = await scanOnce($app); } catch { toast('تعذّر فتح الكاميرا. تأكد من السماح بها.', 4500); return; }
  if (!code) return;
  const c = ledger.findByCode(code);
  if (c) location.hash = `#/record/${c.id}`; else toast('بطاقة غير معروفة');
}

async function pickContact() {
  try {
    const [p] = await navigator.contacts.select(['name', 'tel'], { multiple: false });
    if (!p) return;
    if (p.name && p.name[0]) /** @type {HTMLInputElement} */ (document.getElementById('f-name')).value = p.name[0];
    if (p.tel && p.tel[0]) /** @type {HTMLInputElement} */ (document.getElementById('f-phone')).value = p.tel[0].replace(/[^\d+]/g, '');
  } catch { /* أُلغي الاختيار */ }
}

// ===== الأحداث (ضغط) =====
const ACTS = {
  back: (el) => { location.hash = el.dataset.to || '#/home'; },
  menu: () => {
    const items = curMenu.map((m) => `<button data-act="menu-do" data-do="${m.d}" data-cid="${m.cid || ''}" role="menuitem">${ic(m.i)}${m.l}</button>`).join('');
    $ov.innerHTML = `<div data-act="menu-close" style="position:absolute;inset:0;z-index:25"></div><div class="menu" role="menu">${items}</div>`;
  },
  'menu-do': (el) => { closeOv(); const fn = ACTS[/** @type {string} */ (el.dataset.do)]; if (fn) fn(el); },
  'menu-close': () => closeOv(),
  theme: async (el) => { meta.theme = /** @type {string} */ (el.dataset.t); await db.setMeta('theme', meta.theme); applyTheme(); closeOv(); render(); },
  scan: () => doScan(),
  'add-from-search': () => { ui.addPrefill = /** @type {HTMLInputElement} */ (document.getElementById('q'))?.value || ''; location.hash = '#/add'; },
  kind: (el) => {
    const k = el.dataset.k;
    if (!ui.rec || k === ui.rec.kind) return;
    if (k === 'purchase') { ui.rec.kind = 'purchase'; render(); return; }
    const pay = k === 'payment';
    const v = pay ? 'pay' : 'ret';
    sheet(`<div class="banner" style="font-size:19px;padding:22px 12px">أنت في وضع ${pay ? 'التسديد' : 'المرتجع'}</div>
      <div class="two"><button data-act="sheet-cancel">رجوع للشراء</button><button class="go" data-act="kind-go" data-k="${k}">متابعة</button></div>`,
      `--kind:var(--${v});--kind-ink:var(--${v}-ink)`, true);
  },
  'kind-go': (el) => { if (ui.rec) ui.rec.kind = /** @type {string} */ (el.dataset.k); closeOv(); render(); },
  'sheet-cancel': () => { closeOv(); if (ui.rec) ui.rec.kind = 'purchase'; render(); },
  key: (el) => {
    if (!ui.rec) return;
    const k = el.dataset.k;
    let a = ui.rec.amt;
    if (k === '⌫') a = a.slice(0, -1);
    else if (k === '.') { if (!a.includes('.')) a = (a || '0') + '.'; }
    else { const d = a.split('.')[1]; if (a.length < 9 && !(d !== undefined && d.length >= 2)) a += k; }
    ui.rec.amt = a;
    const big = document.getElementById('amt');
    if (big) big.textContent = a || '0';
  },
  save: () => { saveRecord(); },
  'sheet-close': () => closeOv(),
  'toggle-all': () => { ui.cust.all = !ui.cust.all; render(); },
  share: (el) => shareStatement(/** @type {string} */ (el.dataset.cid)),
  np: (el) => { // أرقام تحت خانة البحث (الكيبورد الرسمي يبقى للأسماء)
    const q = /** @type {HTMLInputElement | null} */ (document.getElementById('q'));
    if (!q) return;
    const k = el.dataset.k;
    q.value = k === '⌫' ? q.value.slice(0, -1) : q.value + k;
    q.dispatchEvent(new Event('input', { bubbles: true }));
  },
  print: (el) => printStatement(/** @type {string} */ (el.dataset.cid)),
  edit: async (el) => { const cid = /** @type {string} */ (el.dataset.cid); if (await requireOwner()) { ui.editOk = cid; location.hash = `#/edit/${cid}`; } },
  txn: (el) => {
    const t = ledger.state.txns.get(/** @type {string} */ (el.dataset.tid));
    if (!t) return;
    sheet(`<div class="row"><span class="pill ${PILL[t.kind]}">${KIND[t.kind]}</span><span class="num" style="font-size:20px">${signed(t)}</span></div>
      <div class="tag">${fullFmt.format(t.ts)}${t.note ? ' · ' + esc(t.note) : ''}</div>
      <div class="form"><label for="reason">سبب العكس (اختياري)</label><input id="reason" autocomplete="off"></div>
      <div class="two"><button data-act="sheet-close">إغلاق</button><button class="btn warn" data-act="void" data-tid="${t.id}">${ic('undo')}عكس العملية</button></div>
      <div class="tag">العكس لا يحذف العملية، تبقى مشطوبة ويظهر العكس في الأحداث.</div>`);
  },
  void: async (el) => {
    const reason = /** @type {HTMLInputElement | null} */ (document.getElementById('reason'))?.value.trim() || null;
    const tid = /** @type {string} */ (el.dataset.tid);
    closeOv();
    if (!(await requireOwner())) return;
    try { ledger.voidTxn(tid, reason); await flush(); toast('✓ تم عكس العملية'); } catch (e) { toast(e instanceof LedgerError ? e.code : 'تعذّر العكس'); }
    render();
  },
  'toggle-lock': () => toggleLock(),
  'toggle-owner': () => toggleOwner(),
  backup: () => backup(),
  restore: () => document.getElementById('restoreFile')?.click(),
  'toggle-add': () => { ui.addOpen = !ui.addOpen; render(); document.getElementById('f-name')?.focus(); },
  acc: (el) => {
    const id = /** @type {string} */ (el.dataset.id); ui.accOpen[id] = !ui.accOpen[id]; render();
    if ((id === 'wa' || id === 'rem') && ui.accOpen[id]) refreshBridge().then(() => render());
    if (id === 'sync' && ui.accOpen[id]) refreshDrive().then(() => render());
    if (id === 'wa' && ui.accOpen[id]) { refreshLink().then(() => render()); startLinkPoll(); } // نتحقق من الجسر لحظة فتح البطاقة
  },
  'toggle-wa': () => setWa('wa.on', !waCfg().on),
  'toggle-wa-auto': () => setWa('wa.auto', !waCfg().auto),
  'toggle-wa-bal': () => setWa('wa.bal', !waCfg().bal),
  'toggle-wa-last': () => setWa('wa.last', !waCfg().last),
  'wa-open': (el) => { document.querySelector('.savedtoast')?.remove(); waSheet(/** @type {string} */ (el.dataset.cid), el.dataset.tid || ''); },
  'apv-no': () => { closeOv(); if (ui.rec) ui.rec.amt = ''; render(); toast('أُلغيت العملية ولم يُسجَّل شيء'); },
  'apv-yes': () => { closeOv(); saveRecord(true); },
  'freeze-open': (el) => {
    ui.frz = 'open';
    const cid = /** @type {string} */ (el.dataset.cid);
    const c = ledger.customer(cid);
    sheet(`<b style="font-size:17px">إيقاف الآجل لـ ${esc(c.name)}</b>
      <div class="opts" id="frzOpts">${[['open', 'إيقاف مفتوح (حتى أعيده أنا)'], ['week', 'لمدة أسبوع'], ['month', 'لمدة شهر'], ['paid', 'حتى يسدّد كامل رصيده']].map(([k, l]) => `<button type="button" data-act="frz-pick" data-k="${k}" aria-pressed="${k === 'open'}"><span class="rd"></span>${l}</button>`).join('')}</div>
      <div class="tag">يمنع الشراء بالآجل فقط. التسديد والمرتجع يعملان كالمعتاد. يرجع الآجل تلقائياً عند انتهاء المدة أو بالسداد حسب اختيارك.</div>
      <div class="two"><button class="btn" data-act="close-ov">إلغاء</button><button class="btn apyes" data-act="frz-yes" data-cid="${cid}">إيقاف الآجل</button></div>`);
  },
  'frz-pick': (el) => { ui.frz = /** @type {string} */ (el.dataset.k); document.querySelectorAll('#frzOpts button').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); },
  'frz-yes': async (el) => {
    const cid = /** @type {string} */ (el.dataset.cid);
    const DAY = 86400000;
    ledger.setFrozen(cid, { frozen: true, until: ui.frz === 'week' ? Date.now() + 7 * DAY : ui.frz === 'month' ? Date.now() + 30 * DAY : null, untilPaid: ui.frz === 'paid' });
    await flush(); closeOv(); render(); toast('✓ أُوقف الآجل لهذا العميل');
  },
  unfreeze: async (el) => { ledger.setFrozen(/** @type {string} */ (el.dataset.cid), { frozen: false }); await flush(); render(); toast('✓ أُعيد الآجل لهذا العميل'); },
  'toggle-cap': async () => { const on = !ledger.state.settings.capEnabled; await setWa('capEnabled', on); if (on && !ledger.state.settings.globalCap) await setWa('globalCap', 100000); },
  'cap-step': (el) => { const g = Number(ledger.state.settings.globalCap || 0); return setWa('globalCap', Math.max(0, g + Number(el.dataset.d) * 10000)); },
  'link-mode': (el) => { ui.linkMode = /** @type {string} */ (el.dataset.m); render(); },
  'link-go': async () => {
    const code = ui.linkMode === 'code';
    const phone = toLatin(ui.linkPhone || '').replace(/\D/g, '');
    if (code && phone.length < 9) { toast('اكتب رقم واتساب البقالة'); return; }
    const ok = await linkRequest(SYNC_URL, meta.syncKey, code ? { mode: 'code', phone } : { mode: 'qr' }, (u, i) => fetch(u, i));
    if (!ok) { toast('تعذّر إرسال الطلب، تحقق من الاتصال'); return; }
    ui.linkAsked = Date.now();
    await refreshLink(); render(); startLinkPoll();
  },
  'drive-retry': async () => { drv.err = ''; render(); await refreshDrive(); render(); },
  'drive-link': async () => {
    const r = await driveCall(SYNC_URL, meta.syncKey, 'POST', 'start', (u, i) => fetch(u, i));
    if (!r || !r.url) { toast(r && r.error === 'not-configured' ? 'نسخ Drive غير مفعّل على السيرفر بعد' : 'تعذّر بدء الربط، تحقق من الاتصال'); return; }
    ui.drvAsked = Date.now(); render(); startDrivePoll();
    window.open(r.url, '_blank');
  },
  'drive-cancel': () => { ui.drvAsked = 0; render(); },
  'drive-now': async () => {
    drv.busy = true; render();
    const r = await driveCall(SYNC_URL, meta.syncKey, 'POST', 'now', (u, i) => fetch(u, i));
    drv.busy = false;
    if (r && r.status) { drv.ok = true; drv.d = r.status; }
    render(); toast(r && r.ok ? '✓ حُفظت نسخة في Google Drive' : 'تعذّر حفظ النسخة الآن');
  },
  'drive-unlink': () => { ui.drvConfirm = true; render(); },
  'drive-unlink-no': () => { ui.drvConfirm = false; render(); },
  'drive-unlink-yes': async () => {
    ui.drvConfirm = false;
    const r = await driveCall(SYNC_URL, meta.syncKey, 'POST', 'unlink', (u, i) => fetch(u, i));
    await refreshDrive(); render(); toast(r && !r.error ? 'تم فصل ربط Google Drive' : 'تعذّر الفصل');
  },
  'link-retry': async () => { link.err = ''; render(); await refreshLink(); render(); startLinkPoll(); },
  'link-cancel': () => { ui.linkAsked = 0; link.state = 'unlinked'; link.code = null; link.qr = null; link.req = null; render(); },
  'link-off': async () => {
    const ok = await linkRequest(SYNC_URL, meta.syncKey, { mode: 'unlink' }, (u, i) => fetch(u, i));
    toast(ok ? 'تم طلب فصل الربط من الجسر' : 'تعذّر إرسال الطلب');
    ui.linkAsked = 0; await refreshLink(); render(); startLinkPoll();
  },
  'toggle-rem': () => { ui.remConfirm = false; return setWa('rem.on', !remSettings(ledger.state.settings).on); },
  'rem-step': (el) => {
    const r = remSettings(ledger.state.settings);
    const d = Number(el.dataset.d);
    ui.remConfirm = false;
    if (el.dataset.k === 'day') return setWa('rem.day', Math.min(28, Math.max(1, r.day + d)));
    if (el.dataset.k === 'hour') return setWa('rem.hour', (r.hour + d + 24) % 24);
    return setWa('rem.min', Math.max(0, r.min + d * 1000)); // ±10 ريال
  },
  'rem-now': async () => {
    if (!ui.remConfirm) { ui.remConfirm = true; render(); window.setTimeout(() => { if (ui.remConfirm) { ui.remConfirm = false; render(); } }, 6000); return; }
    ui.remConfirm = false;
    if (!meta.syncOn) { toast('يحتاج تفعيل المزامنة مع السيرفر'); render(); return; }
    await refreshBridge();
    if (!bridge.alive) { toast('الجسر غير متصل الآن، لا يمكن الإرسال'); render(); return; }
    await setWa('rem.now', Date.now());
    schedSync(100);
    toast('✓ بدأ إرسال التذكير. يرسله الجسر تدريجياً.', 4500);
  },
  'wa-edit': (el) => {
    const t = /** @type {HTMLTextAreaElement} */ (document.getElementById('waText'));
    const r = document.getElementById('waRc');
    if (!t || !r) return;
    const toEdit = t.hidden;
    t.hidden = !toEdit; r.hidden = toEdit;
    const lbl = el.querySelector('span'); if (lbl) lbl.textContent = toEdit ? 'عرض الشكل' : 'تعديل النص';
    if (toEdit) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; t.focus(); }
  },
  'wa-go': async (el) => {
    const c = ledger.customer(/** @type {string} */ (el.dataset.cid));
    const text = /** @type {HTMLTextAreaElement} */ (document.getElementById('waText')).value;
    const tid = el.dataset.tid;
    if (tid && meta.syncOn && meta.syncKey) { // نأخذ الدور من السيرفر حتى لا يرسلها الجسر أيضاً
      const r = await claimManual(SYNC_URL, meta.syncKey, tid, (u, i) => fetch(u, i));
      if (r && !r.ok && (r.status === 'sent' || r.status === 'sending')) { closeOv(); toast('أُرسلت تلقائياً للعميل ✓'); return; }
    }
    closeOv();
    window.open(`https://wa.me/${waNumber(c.phone)}?text=${encodeURIComponent(text)}`, '_blank');
  },
  'toggle-sync': async () => {
    if (meta.syncOn) {
      meta.syncOn = false; await db.setMeta('syncOn', false); syncClient = null; clearTimeout(syncTimer);
    } else if (meta.syncKey && !ui.syncSetup) {
      meta.syncOn = true; await db.setMeta('syncOn', true); startSync(); schedSync(100);
    } else ui.syncSetup = !ui.syncSetup;
    render();
  },
  'sync-change': async () => {
    clearTimeout(syncTimer); syncClient = null;
    meta.syncOn = false; meta.syncKey = ''; ui.syncSetup = true;
    await db.setMeta('syncOn', false); await db.setMeta('syncKey', '');
    render();
  },
  'sync-link': async () => {
    const key = toLatin(/** @type {HTMLInputElement} */ (document.getElementById('syncKeyInput'))?.value || '').trim();
    if (!key) { toast('الصق مفتاح البقالة أولاً'); return; }
    const r = await verifyKey(SYNC_URL, key, (u, i) => fetch(u, i));
    if (r !== 'ok') { toast({ unauthorized: 'المفتاح غير صحيح', disabled: 'الخدمة موقوفة لهذه البقالة', offline: 'لا يوجد إنترنت الآن', error: 'تعذّر الاتصال بالسيرفر' }[r], 3500); return; }
    ui.syncKeyPending = key;
    sheet(`<div class="banner" style="font-size:16px;line-height:1.8;padding:16px 12px;font-weight:600">سيتم ربط هذا الجوال ببقالتك ودمج دفتره مع الدفتر الموجود على السيرفر. لا يُحذف شيء.</div>
      <div class="two"><button data-act="close-ov">رجوع</button><button class="go" data-act="sync-confirm">ربط</button></div>`, '', true);
  },
  'close-ov': () => { ui.syncKeyPending = ''; closeOv(); },
  'sync-confirm': async () => {
    const key = ui.syncKeyPending; ui.syncKeyPending = '';
    closeOv();
    if (!key) return;
    Object.assign(meta, { syncKey: key, syncOn: true, syncCursor: 0, syncLastAt: 0, syncPushed: new Set() });
    await db.setMeta('syncKey', key); await db.setMeta('syncOn', true); await db.setMeta('syncCursor', 0);
    await db.setMeta('syncLastAt', 0); await db.setMeta('syncPushed', []);
    ui.syncSetup = false;
    startSync(); render();
    const st = await runSync();
    toast(st === 'idle' ? '✓ تم الربط والمزامنة' : 'تم الربط. ستكتمل المزامنة عند توفر الاتصال', 3500);
    render();
  },
  'sync-now': async () => {
    if (!syncClient) return;
    toast('جارٍ المزامنة...', 1200);
    const st = await runSync();
    toast(st === 'idle' ? '✓ تمت المزامنة' : SYNC_MSG[st || 'error'][0], 3500);
    render();
  },
  'pick-contact': () => pickContact(),
  redo: async (el) => {
    const ev = eventsLog(ledger.allOps()).find((e) => e.id === el.dataset.id);
    if (!ev || ev.type !== 'txn.void' || !(await requireOwner())) return;
    try { ledger.addTxn(ev.cid, ev.kind, ev.amount, { approve: true }); await flush(); toast('✓ أُعيد تسجيل العملية'); } catch (e) { toast(e instanceof LedgerError ? (ERR[e.code] || e.code) : 'تعذّر'); }
    render();
  },
  'restore-edit': async (el) => {
    const ev = eventsLog(ledger.allOps()).find((e) => e.id === el.dataset.id);
    if (!ev || ev.type !== 'customer.update' || !(await requireOwner())) return;
    /** @type {Record<string, any>} */
    const patch = { force: true };
    for (const c of ev.changes) patch[c.field] = c.from;
    try { ledger.updateCustomer(ev.cid, patch); await flush(); toast('✓ تم استرجاع القيم السابقة'); } catch { toast('تعذّر الاسترجاع'); }
    render();
  },
  unlock: () => tryUnlock(),
};

document.addEventListener('click', (e) => {
  const el = /** @type {HTMLElement} */ (e.target).closest('[data-act]');
  if (!el) return;
  const act = /** @type {HTMLElement} */ (el).dataset.act;
  const fn = ACTS[act];
  if (fn) fn(/** @type {HTMLElement} */ (el));
});

document.addEventListener('input', (e) => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (t.id === 'shopNameIn' || t.id === 'shopPhoneIn') { // حفظ تلقائي أثناء الكتابة (بعد توقف نصف ثانية)
    clearTimeout(waShopTimer);
    waShopTimer = window.setTimeout(() => saveShop(t), 600);
  }
  if (t.id === 'linkPhone') ui.linkPhone = toLatin(t.value);
  if (t.id === 'waText') { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  if (t.id === 'q' || t.id === 'dq') t.value = toLatin(t.value);
  if (t.id === 'q') { const r = document.getElementById('results'); if (r) r.innerHTML = resultsHtml(t.value); }
  if (t.id === 'dq') { ui.debtQ = t.value; const pos = t.selectionStart; render(); const n = /** @type {HTMLInputElement | null} */ (document.getElementById('dq')); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
});

// صف الأرقام: يظهر مع التركيز على خانة البحث، والضغط عليه لا يُغلق الكيبورد
// الإخفاء متأخر قليلاً: لو اختفى الصف فوراً عند أول لمسة لنتيجة البحث، ينزاح السطر وتضيع اللمسة (تحتاج ضغطتين)
let npTimer = 0;
document.addEventListener('focusin', (e) => { if (/** @type {HTMLElement} */ (e.target).id === 'q') { clearTimeout(npTimer); document.getElementById('numpad')?.classList.add('on'); } });
document.addEventListener('focusout', (e) => { if (/** @type {HTMLElement} */ (e.target).id === 'q') { clearTimeout(npTimer); npTimer = window.setTimeout(() => document.getElementById('numpad')?.classList.remove('on'), 450); } });
document.addEventListener('pointerdown', (e) => { if (/** @type {HTMLElement} */ (e.target).closest?.('#numpad')) e.preventDefault(); });

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  if (f.id === 'addForm') submitAdd();
  if (f.id === 'editForm') submitEdit(/** @type {string} */ (f.dataset.cid));
});

document.addEventListener('change', (e) => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (t.id === 'shopNameIn' || t.id === 'shopPhoneIn') saveShop(t);
  if (t.id === 'restoreFile' && t.files && t.files[0]) { restoreFrom(t.files[0]); t.value = ''; }
});

window.addEventListener('hashchange', () => { closeOv(); render(); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  schedSync(500);
  if (meta.lockEnabled && !locked && hiddenAt && Date.now() - hiddenAt > RELOCK_MS) { locked = true; render(); }
});

// ===== التشغيل =====
async function boot() {
  const ops = await db.loadOps();
  let deviceId = await db.getMeta('deviceId');
  if (!deviceId) { deviceId = shortId(10); await db.setMeta('deviceId', deviceId); }
  meta.deviceId = deviceId;
  meta.lockEnabled = await db.getMeta('lockEnabled', false);
  meta.credId = await db.getMeta('credId');
  meta.ownerRequired = await db.getMeta('ownerRequired', false);
  meta.ownerPin = await db.getMeta('ownerPin');
  meta.theme = await db.getMeta('theme', 'auto');
  meta.lastBackupAt = await db.getMeta('lastBackupAt', 0);
  meta.syncOn = await db.getMeta('syncOn', false);
  meta.syncKey = await db.getMeta('syncKey', '');
  meta.syncCursor = await db.getMeta('syncCursor', 0);
  meta.syncLastAt = await db.getMeta('syncLastAt', 0);
  meta.syncPushed = new Set(await db.getMeta('syncPushed', []));
  ledger = new Ledger({ deviceId, ops });
  for (const id of ledger.opIds()) saved.add(id);
  applyTheme();
  db.requestPersistence();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
    // إصدار جديد جاهز: نعيد التحميل بصمت لو ما فيه كتابة جارية، وإلا ننبّه
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (!ui.rec || !ui.rec.amt) location.reload();
      else toast('يوجد تحديث جديد. أعد فتح التطبيق بعد إنهاء العملية.', 6000);
    });
  }
  locked = meta.lockEnabled && !!meta.credId;
  if (!location.hash) location.hash = '#/home';
  startSync();
  render();
  if (locked) tryUnlock(); else schedSync(800);
  window.addEventListener('online', () => schedSync(300));
  window.setInterval(() => { if (!document.hidden) schedSync(0); }, 60000);
}

boot().catch((err) => {
  $v.innerHTML = `<div class="lockscreen"><b>تعذّر تشغيل التطبيق</b><div class="tag center">${esc(err && err.message)}</div></div>`;
});
