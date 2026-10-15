// @ts-check
// وضع التدريب: 30 عميلاً وهمياً بحركات موزّعة على آخر 40 يوماً، ليتدرّب عليها الموظف في دفتر منفصل تماماً
// (بلا مزامنة ولا واتساب ولا Drive). الأسماء والأرقام وهمية، والتوليد ثابت (نفس العملاء كل مرة).

const DAY = 86400000;

/** [الاسم، الجوال، النوع] — النوع: debt مدين، paid مسدّد، credit له رصيد عندنا، frozen آجل موقوف، big مدين كبير */
const DEMO = [
  ['أبو خالد', '0500000101', 'debt'], ['أم محمد', '0500000102', 'debt'], ['سعد العتيبي', '0500000103', 'debt'],
  ['فهد الدوسري', '0500000104', 'debt'], ['نورة القحطاني', '0500000105', 'debt'], ['عبدالله الشمري', '0500000106', 'debt'],
  ['أبو سلطان', '0500000107', 'debt'], ['ماجد الحربي', '0500000108', 'debt'], ['أم فيصل', '0500000109', 'debt'],
  ['ياسر الزهراني', '0500000110', 'debt'], ['بدر المطيري', '', 'debt'], ['سارة العنزي', '0500000112', 'debt'],
  ['أبو ناصر', '0500000113', 'big'], ['مطعم الواحة', '0500000114', 'big'], ['ورشة الأمل', '', 'big'],
  ['خالد السبيعي', '0500000116', 'paid'], ['منى الغامدي', '0500000117', 'paid'], ['أبو راكان', '0500000118', 'paid'],
  ['تركي البقمي', '0500000119', 'paid'], ['هند الرشيدي', '', 'paid'], ['عادل اليامي', '0500000121', 'paid'],
  ['أبو عمر', '0500000122', 'paid'], ['لولوة السهلي', '0500000123', 'paid'], ['رائد العسيري', '0500000124', 'paid'],
  ['أم عبدالرحمن', '0500000125', 'credit'], ['سلمان الجهني', '0500000126', 'credit'], ['أبو بندر', '0500000127', 'credit'],
  ['حمد المالكي', '0500000128', 'frozen'], ['فاطمة البلوي', '0500000129', 'frozen'], ['عبدالعزيز التميمي', '0500000130', 'debt'],
];

/** رقم ثابت من الاسم (لتنويع المبالغ دون عشوائية). @param {string} s @param {number} i */
function seed(s, i) { let h = 7 + i * 31; for (const ch of s) h = (h * 33 + ch.charCodeAt(0)) % 100003; return h; }

/**
 * يملأ دفتراً فارغاً بعملاء التدريب. يستعمل ساعة الدفتر مؤقتاً لتوزيع التواريخ ثم يعيدها.
 * @param {import('./ledger.js').Ledger} ledger
 * @param {number} [now]
 */
export function seedTraining(ledger, now = Date.now()) {
  const realClock = ledger.clock;
  const guard = ledger.writeGuard; ledger.writeGuard = null;
  let t = now;
  ledger.clock = () => t;
  const at = (/** @type {number} */ daysAgo, /** @type {number} */ hourShift = 0) => { t = now - daysAgo * DAY + hourShift * 3600000; };
  try {
    DEMO.forEach(([name, phone, kind], i) => {
      const h = seed(name, i);
      at(45 - (i % 5));
      const { customer } = ledger.addCustomer({ name, phone: phone || null });
      const cid = customer.id;
      const buy = (/** @type {number} */ d, /** @type {number} */ riyals) => { at(d, (h % 9)); ledger.addTxn(cid, 'purchase', riyals * 100, { approve: true }); };
      const pay = (/** @type {number} */ d, /** @type {number} */ riyals) => { at(d, (h % 7)); ledger.addTxn(cid, 'payment', riyals * 100); };
      const n = 3 + (h % 4); // عدد المشتريات
      const amounts = Array.from({ length: n }, (_, k) => 15 + ((h >> k) % 18) * 5 + (kind === 'big' ? 120 : 0));
      const total = amounts.reduce((a, b) => a + b, 0);
      if (kind === 'paid') {
        amounts.forEach((a, k) => buy(38 - k * 5, a));
        pay(3 + (h % 4), total);
      } else if (kind === 'credit') {
        amounts.forEach((a, k) => buy(36 - k * 5, a));
        pay(4, total + 40 + (h % 5) * 10);
      } else {
        amounts.forEach((a, k) => buy(Math.max(1, 34 - k * 6 - (h % 3)), a));
        if (i % 3 === 0) pay(2 + (h % 5), Math.max(5, Math.round(total / 3 / 5) * 5)); // تسديد جزئي
        if (i % 7 === 0) { at(1, 2); ledger.addTxn(cid, 'return', 1500); } // مرتجع صغير
        if (kind === 'frozen') { at(1); ledger.setFrozen(cid, { frozen: true, until: null, untilPaid: true, reason: 'تدريب' }); }
      }
    });
  } finally {
    ledger.clock = realClock;
    ledger.writeGuard = guard;
  }
}

/** عدد عملاء التدريب (للاختبار). */
export const TRAINING_COUNT = DEMO.length;
