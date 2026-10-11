// @ts-check
// تحويل بيانات دفتر الأجل القديم (SQLite: جدولا customers و txns) إلى عمليات.
// البطاقات المطبوعة القديمة (CUST-0085) تبقى تشتغل لأن رقمها ينحفظ مع العميل.

import { OP } from './ops.js';
import { shortId, opId } from './util.js';

const OLD_OPENING_NOTE = 'رصيد سابق (دفتر قديم)';

/**
 * @param {{
 *   customers: {id: string, code_no: number, name: string, phone?: string | null, credit_cap?: number | null, archived?: number | null, created_at: number}[],
 *   txns: {id: number, customer_id: string, amount: number, kind: string, note?: string | null, created_at: number}[],
 * }} old
 * @param {string} deviceId
 * @returns {import('./ops.js').Op[]}
 */
export function opsFromLegacy(old, deviceId) {
  /** @type {import('./ops.js').Op[]} */
  const ops = [];
  /** @type {Map<string, string>} */
  const cidByOld = new Map();
  for (const c of old.customers) {
    const cid = shortId();
    cidByOld.set(c.id, cid);
    ops.push({
      id: opId(), dev: deviceId, ts: c.created_at, type: OP.CUSTOMER_CREATE,
      data: {
        cid, name: c.name, phone: c.phone || null, codeNo: c.code_no, legacyCode: c.id,
        cap: c.credit_cap && c.credit_cap > 0 ? Math.round(c.credit_cap * 100) : null,
      },
    });
    if (c.archived) {
      ops.push({ id: opId(), dev: deviceId, ts: c.created_at + 1, type: OP.CUSTOMER_ARCHIVE, data: { cid, archived: true } });
    }
  }
  for (const t of old.txns) {
    const cid = cidByOld.get(t.customer_id);
    const amount = Math.round(Number(t.amount) * 100);
    if (!cid || !(amount > 0)) continue;
    const isOpening = t.kind === 'purchase' && t.note === OLD_OPENING_NOTE;
    ops.push({
      id: opId(), dev: deviceId, ts: t.created_at, type: OP.TXN,
      data: {
        tid: shortId(12), cid, amount,
        kind: isOpening ? 'opening' : t.kind,
        note: isOpening ? null : (t.note || null),
      },
    });
  }
  return ops;
}
