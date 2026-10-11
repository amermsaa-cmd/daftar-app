// تطبيق دفتر الأجل على الجوال (الوضع الأول): بدون سيرفر، كل البيانات على الجهاز.
// القلب (packages/core) يحسب كل شيء من سجل العمليات، وهذا الملف واجهة فقط.
import {
  Ledger, LedgerError, toHalalas, formatMoney, shortId,
  statement, debtTable, analyticsSummary, eventsLog,
} from './core/index.js';
import * as db from './db.js';
import * as lock from './lock.js';
import { scanSupported, scanOnce } from './scan.js';

const VERSION = '0.2.0';
const RELOCK_MS = 5 * 60 * 1000;

/** @type {Ledger} */
let ledger;
const meta = { deviceId: '', lockEnabled: false, credId: null, ownerRequired: false, ownerPin: null, theme: 'auto', lastBackupAt: 0 };
const saved = new Set();
let locked = false;
let hiddenAt = 0;
const ui = { rec: null, cust: { all: false }, editOk: null, addPrefill: '', debtQ: '' };

const $app = /** @type {HTMLElement} */ (document.getElementById('app'));
$app.innerHTML = '<div id="v"></div><div id="ov"></div>';
const $v = /** @type {HTMLElement} */ (document.getElementById('v'));
const $ov = /** @type {HTMLElement} */ (document.getElementById('ov'));

// ===== أدوات عرض =====
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
}

// ===== هيكل الصفحة =====
const NAV = [['home', 'home', 'الرئيسية'], ['debts', 'list', 'الديون'], ['reports', 'chart', 'التقارير'], ['settings', 'gear', 'الإعدادات']];

function page({ title, back = '', body, nav = '', extra = '', style = '', sub = '' }) {
  const navHtml = nav ? `<nav class="nav">${NAV.map(([r, i, l]) => `<a href="#/${r}" class="${nav === r ? 'on' : ''}">${ic(i)}${l}</a>`).join('')}</nav>` : '';
  const top = `<div class="top">${back ? `<button class="back" data-act="back" data-to="${back}" aria-label="رجوع">${ic('back')}</button>` : ''}${title}${extra}
      <button class="dotsbtn" data-act="menu" aria-label="القائمة">${ic('dots')}</button></div>`;
  return `<div class="pg" style="${style}">
    ${sub ? `<div class="rechead">${top}${sub}</div>` : top}
    ${body}${navHtml}</div>`;
}

// ===== الشاشات =====
function recentCustomers() {
  const s = ledger.state;
  const last = new Map();
  for (const t of s.txns.values()) if (!t.voided && t.ts > (last.get(t.cid) || 0)) last.set(t.cid, t.ts);
  return [...s.customers.values()].filter((c) => !c.archived)
    .sort((a, b) => (last.get(b.id) || b.createdAt) - (last.get(a.id) || a.createdAt)).slice(0, 8);
}

function customerRows(list) {
  return list.map((c) => `<a class="card row" href="#/record/${c.id}"><div class="nm"><b>${esc(c.name)}</b><small>رقم ${c.codeNo}</small></div>${balHtml(c)}</a>`).join('');
}

function resultsHtml(q) {
  if (!q.trim()) {
    const list = recentCustomers();
    if (!list.length) return `<div class="card center stack"><div>لا يوجد عملاء بعد</div><a class="btn main" href="#/add">${ic('user-plus')}إضافة أول عميل</a></div>`;
    return `<div class="tag">آخر العملاء</div>${customerRows(list)}`;
  }
  const list = ledger.search(q);
  if (!list.length) return `<div class="card center stack"><div>لا يوجد عميل بهذا الاسم أو الرقم</div><button class="btn" data-act="add-from-search">${ic('user-plus')}إضافة عميل جديد</button></div>`;
  return customerRows(list);
}

function viewHome() {
  const body = `<div class="body">
    <div class="field">${ic('search')}<input id="q" type="search" inputmode="search" autocomplete="off" placeholder="ابحث بالرقم أو الاسم" aria-label="بحث"><button type="button" class="btn main" data-act="scan" aria-label="مسح بطاقة العميل" style="width:40px;height:40px;padding:0;border-radius:10px">${ic('scan')}</button></div>
    <div id="results" class="stack">${resultsHtml('')}</div></div>`;
  return page({ title: 'الرئيسية', body, nav: 'home' });
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
  return page({ title: 'تسجيل عملية', back: '#/home', sub, body, style: `--kind:var(--${v});--kind-ink:var(--${v}-ink)` });
}

function viewCustomer(cid) {
  const s = ledger.state;
  const c = s.customers.get(cid);
  if (!c) return viewMissing();
  const st = statement(s, cid, { cycleOnly: !ui.cust.all });
  const days = [...st.days].reverse().map((d) => `<div class="day">${dayFmt.format(d.date)}</div>` +
    [...d.rows].reverse().map(({ txn: t, after }) => `<button class="card row" style="width:100%;text-align:inherit;cursor:pointer" data-act="txn" data-tid="${t.id}">
      <span class="pill ${PILL[t.kind]}">${KIND[t.kind]}</span><span class="tag">${timeFmt.format(t.ts)}${t.note ? ' · ' + esc(t.note) : ''}</span>
      <span class="num">${signed(t)}<small>${fmt(after)}</small></span></button>`).join('')).join('');
  const body = `<div class="body">
    <div class="card center"><b style="font-size:18px">${esc(c.name)}</b>
      <div class="tag">رقم ${c.codeNo}${c.phone ? ' · ' + esc(c.phone) : ''}</div>
      <div class="big ${c.balance > 0 ? 'owe' : c.balance < 0 ? 'pos' : ''}" style="padding-bottom:0">${c.balance < 0 ? 'له ' : ''}${fmt(Math.abs(c.balance))}</div>
      <div class="tag">${ui.cust.all ? 'كل الحركات' : 'المستحق منذ آخر تصفية'}</div>
</div>
    <a class="btn main" href="#/record/${c.id}">${ic('cart')}تسجيل عملية</a>
    <div class="two"><button class="btn" data-act="share" data-cid="${c.id}">${ic('share')}مشاركة</button><button class="btn" data-act="print" data-cid="${c.id}">${ic('print')}طباعة</button></div>
    <div class="two"><button class="btn" data-act="toggle-all">${ic('list')}${ui.cust.all ? 'الدورة الحالية' : 'عرض الكل'}</button><button class="btn" data-act="edit" data-cid="${c.id}">${ic('gear')}تعديل البيانات</button></div>
    ${days || '<div class="card center tag">لا توجد حركات بعد</div>'}</div>`;
  return page({ title: 'حساب العميل', back: '#/home', body });
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
  return page({ title: 'إضافة عميل', back: '#/settings', body });
}

function viewEdit(cid) {
  const c = ledger.state.customers.get(cid);
  if (!c) return viewMissing();
  if (ui.editOk !== cid) { location.hash = `#/customer/${cid}`; return ''; }
  const body = `<div class="body"><form id="editForm" class="stack" data-cid="${c.id}" autocomplete="off">
    <div class="form"><label for="f-name">اسم العميل</label><input id="f-name" required value="${esc(c.name)}"></div>
    <div class="form"><label for="f-phone">رقم الجوال</label><input id="f-phone" type="tel" inputmode="tel" dir="ltr" style="text-align:right" value="${esc(c.phone || '')}"></div>
    <div class="tag">كل تعديل يُسجَّل في الأحداث ويمكن الرجوع عنه.</div>
    <div id="formErr"></div>
    <button class="btn main" type="submit">حفظ التعديل</button></form></div>`;
  return page({ title: 'تعديل العميل', back: `#/customer/${cid}`, body });
}

function viewDebts() {
  const now = Date.now();
  const rows = debtTable(ledger.state, now, 'debt');
  const total = rows.reduce((a, r) => a + r.customer.balance, 0);
  const q = ui.debtQ.trim();
  const shown = q ? rows.filter((r) => ledger.search(q, { limit: 500 }).some((c) => c.id === r.customer.id)) : rows;
  const list = shown.map((r) => `<a class="card row" href="#/customer/${r.customer.id}"><div class="nm"><b>${esc(r.customer.name)}</b><small>${r.days === 0 ? 'آخر حركة اليوم' : `منذ ${r.days} يوم`}</small></div><span class="num owe">${fmt(r.customer.balance)}</span></a>`).join('');
  const body = `<div class="body">
    <div class="field">${ic('search')}<input id="dq" type="search" autocomplete="off" placeholder="ابحث في الجدول" value="${esc(ui.debtQ)}"></div>
    ${list || '<div class="card center tag">لا توجد ديون حالياً</div>'}</div>`;
  return page({ title: 'جدول الديون', body, nav: 'debts', extra: `<span class="sp"></span><span class="tag">المجموع</span><span class="num owe">${fmt(total)}</span>` });
}

function viewReports() {
  const now = Date.now();
  const s = ledger.state;
  const a = analyticsSummary(s, now);
  const top = debtTable(s, now, 'debt').slice(0, 5);
  const max = top[0] ? top[0].customer.balance : 1;
  const late = debtTable(s, now, 'overdue30');
  const body = `<div class="body">
    <div class="stat"><div class="card"><div class="tag">إجمالي الديون</div><div class="num owe" style="font-size:22px">${fmt(a.totalOutstanding)}</div><div class="tag">${a.customersWithDebt} عميل</div></div>
      <div class="card"><div class="tag">المسدد هذا الشهر</div><div class="num" style="font-size:22px;color:var(--pay)">${fmt(a.collectedMonth)}</div><div class="tag">شراء جديد ${fmt(a.newDebtMonth)}</div></div></div>
    <div class="card stack"><b>أكبر المدينين</b>${top.length ? top.map((r) => `<div><div class="row"><span>${esc(r.customer.name)}</span><span class="num">${fmt(r.customer.balance)}</span></div><div class="bar"><i style="width:${Math.max(4, Math.round(r.customer.balance / max * 100))}%"></i></div></div>`).join('') : '<div class="tag">لا ديون</div>'}</div>
    <div class="card stack"><div class="row"><b>المتأخرون</b><span class="pill">أكثر من 30 يوماً</span></div>
      ${late.length ? late.map((r) => `<div class="row"><span>${esc(r.customer.name)}</span><span class="num owe">${fmt(r.customer.balance)}</span></div>`).join('') : '<div class="tag">لا يوجد متأخرون</div>'}</div></div>`;
  return page({ title: 'التقارير', body, nav: 'reports' });
}

const tgl = (act, on) => `<button class="tg" role="switch" aria-checked="${on}" data-act="${act}"><i></i></button>`;

function viewSettings() {
  const evCount = eventsLog(ledger.allOps()).length;
  const lastB = meta.lastBackupAt ? fullFmt.format(meta.lastBackupAt) : 'لم تؤخذ نسخة بعد';
  const body = `<div class="body">
    <a class="btn" href="#/add">${ic('user-plus')}إضافة عميل</a>
    <div class="card stack"><div class="sw"><div><b>قفل التطبيق</b><div class="tag">بصمة الجوال أو رمز فتحه نفسه</div></div>${tgl('toggle-lock', meta.lockEnabled)}</div>
      <div class="tag">مطفأ افتراضياً، فيفتح التطبيق مباشرة. صاحب الجوال يفعّله أو يعطّله متى شاء.</div></div>
    <div class="card stack"><div class="sw"><div><b>رمز صاحب البقالة</b><div class="tag">اطلب رمزاً لعكس العمليات وتعديل العملاء</div></div>${tgl('toggle-owner', meta.ownerRequired)}</div>
      <div class="tag">مطفأ افتراضياً. كل عكس أو تعديل يُسجَّل في الأحداث حتى لو كان الرمز مطفأً. احفظ الرمز جيداً.</div></div>
    <a class="card stack" href="#/events" style="text-decoration:none;color:inherit"><div class="row"><b>الأحداث</b>${ic('clock')}</div><div class="tag">${evCount ? evCount + ' حدث (عكس وتعديل وأرشفة)' : 'لا توجد أحداث بعد'}</div></a>
    <div class="card stack"><b>النسخة الاحتياطية</b>
      <div class="two"><button class="btn" data-act="backup">${ic('share')}إرسال عبر واتساب</button><button class="btn" data-act="restore">${ic('save')}استرجاع</button></div>
      <input id="restoreFile" type="file" accept=".json,application/json" hidden>
      <div class="tag">آخر نسخة: ${lastB}</div>
      <div class="tag" id="persistTag">التخزين الدائم: ...</div></div>
    <div class="card stack" style="opacity:.55"><div class="row"><span>اسم الموظف مع العملية</span>${ic('lock')}</div><div class="row"><span>سقف الدين</span>${ic('lock')}</div><div class="tag">خيارات مقفلة، تُفتح في إصدارات لاحقة</div></div>
    <div class="tag center">دفتر الأجل ${VERSION} · الجهاز ${esc(meta.deviceId)}</div></div>`;
  return page({ title: 'الإعدادات', body, nav: 'settings' });
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
    if (e.type === 'customer.update') return `<div class="card stack"><div class="row"><b>تعديل بيانات ${name(e.cid)}</b><span class="pill">تعديل</span></div>
      ${e.changes.map((c) => `<div class="tag">${fieldName[c.field]}: ${val(c.field, c.from)} ← ${val(c.field, c.to)}</div>`).join('')}
      <div class="tag">${fullFmt.format(e.ts)}</div>
      <button class="btn" data-act="restore-edit" data-id="${e.id}">${ic('undo')}استرجاع القيم السابقة</button></div>`;
    return `<div class="card stack"><div class="row"><b>${e.archived ? 'أرشفة' : 'إلغاء أرشفة'} ${name(e.cid)}</b><span class="pill">أرشفة</span></div><div class="tag">${fullFmt.format(e.ts)}</div></div>`;
  }).join('');
  const body = `<div class="body">${list || '<div class="card center tag">لا توجد أحداث بعد</div>'}</div>`;
  return page({ title: 'الأحداث', back: '#/settings', body });
}

function viewMissing() {
  return page({ title: 'غير موجود', back: '#/home', body: '<div class="body"><div class="card center">لم نجد هذا العميل</div></div>' });
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

async function saveRecord() {
  const r = ui.rec;
  if (!r) return;
  const amount = toHalalas(r.amt);
  if (!amount) { toast('أدخل مبلغاً'); return; }
  try {
    const fn = { purchase: 'purchase', payment: 'payment', return: 'ret' }[r.kind];
    const res = ledger[fn](r.cid, amount);
    await flush();
    const c = ledger.customer(r.cid);
    toast(`✓ ${KIND[r.kind]} ${fmt(amount)} · ${c.name} · الرصيد ${c.balance < 0 ? 'له ' : ''}${fmt(Math.abs(res.balance))}`, 3500);
    ui.rec = null;
    location.hash = '#/home';
  } catch (e) {
    toast(e instanceof LedgerError ? (ERR[e.code] || e.code) : 'تعذّر الحفظ');
  }
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
    ledger.updateCustomer(cid, { name, phone, force });
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
  document.getElementById('printArea').innerHTML = `<h2>كشف حساب: ${esc(c.name)} (رقم ${c.codeNo})</h2>
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
    const opt = (t, i, l) => `<button data-act="theme" data-t="${t}" role="menuitemradio" aria-checked="${meta.theme === t}">${ic(i)}${l}</button>`;
    $ov.innerHTML = `<div data-act="menu-close" style="position:absolute;inset:0;z-index:25"></div><div class="menu" role="menu">${opt('auto', 'auto', 'تلقائي (حسب الجوال)')}${opt('light', 'sun', 'الوضع النهاري')}${opt('dark', 'moon', 'الوضع الليلي')}</div>`;
  },
  'menu-close': () => closeOv(),
  theme: async (el) => { meta.theme = /** @type {string} */ (el.dataset.t); await db.setMeta('theme', meta.theme); applyTheme(); closeOv(); },
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
  if (t.id === 'q') { const r = document.getElementById('results'); if (r) r.innerHTML = resultsHtml(t.value); }
  if (t.id === 'dq') { ui.debtQ = t.value; const pos = t.selectionStart; render(); const n = /** @type {HTMLInputElement | null} */ (document.getElementById('dq')); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = /** @type {HTMLFormElement} */ (e.target);
  if (f.id === 'addForm') submitAdd();
  if (f.id === 'editForm') submitEdit(/** @type {string} */ (f.dataset.cid));
});

document.addEventListener('change', (e) => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (t.id === 'restoreFile' && t.files && t.files[0]) { restoreFrom(t.files[0]); t.value = ''; }
});

window.addEventListener('hashchange', () => { closeOv(); render(); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
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
  ledger = new Ledger({ deviceId, ops });
  for (const id of ledger.opIds()) saved.add(id);
  applyTheme();
  db.requestPersistence();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  locked = meta.lockEnabled && !!meta.credId;
  if (!location.hash) location.hash = '#/home';
  render();
  if (locked) tryUnlock();
}

boot().catch((err) => {
  $v.innerHTML = `<div class="lockscreen"><b>تعذّر تشغيل التطبيق</b><div class="tag center">${esc(err && err.message)}</div></div>`;
});
