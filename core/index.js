// @ts-check
// قلب دفتر الأجل — يشتغل كما هو في المتصفح (تطبيق الجوال) وفي Node (الكمبيوتر والسيرفر).
export * from './util.js';
export * from './ops.js';
export { Ledger, LedgerError, CARD_PREFIX, effectiveCap, isFrozenNow, cardCode } from './ledger.js';
export {
  ARABIC_MONTHS, listCustomers, customerTxns, currentCycle, monthlySummary, monthDetail,
  availableMonths, statement, agingDays, analyticsSummary, analyticsAging, debtTable,
} from './reports.js';
export { opsFromLegacy } from './legacy.js';
export { eventsLog } from './events.js';
export { waNumber, waSettings, shopInfo, waMessage, waAccountTag, waReminder, remSettings, remDue, remOpId, remPlan, riyadhParts, waSkipReason, waStamp, pendingWa } from './notify.js';
export * from './license.js';
