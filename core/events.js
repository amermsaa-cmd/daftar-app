// @ts-check
// سجل الأحداث: كل عكس أو تعديل أو أرشفة، مع القيمة قبل وبعد.
// يُحسب من سجل العمليات نفسه، فلا يُحفظ شيء إضافي ولا يمكن إيقافه.

import { OP, compareOps } from './ops.js';

/** @typedef {import('./ops.js').Op} Op */
/** @typedef {import('./ops.js').TxnKind} TxnKind */

/**
 * @typedef {object} VoidEvent
 * @property {string} id معرّف العملية الأصلية
 * @property {number} ts
 * @property {'txn.void'} type
 * @property {string} cid
 * @property {string} tid
 * @property {TxnKind} kind نوع الحركة الملغاة
 * @property {number} amount بالهللة
 * @property {string | null} reason
 *
 * @typedef {object} UpdateEvent
 * @property {string} id
 * @property {number} ts
 * @property {'customer.update'} type
 * @property {string} cid
 * @property {{field: 'name' | 'phone' | 'cap', from: any, to: any}[]} changes
 *
 * @typedef {object} ArchiveEvent
 * @property {string} id
 * @property {number} ts
 * @property {'customer.archive'} type
 * @property {string} cid
 * @property {boolean} archived
 *
 * @typedef {object} ExceptionEvent  شراء سُجّل كاستثناء (عميل موقوف أو تجاوز سقف)
 * @property {string} id
 * @property {number} ts
 * @property {'txn.exception'} type
 * @property {string} cid
 * @property {string} tid
 * @property {TxnKind} kind
 * @property {number} amount بالهللة
 *
 * @typedef {object} FreezeEvent
 * @property {string} id
 * @property {number} ts
 * @property {'customer.freeze'} type
 * @property {string} cid
 * @property {boolean} frozen
 * @property {number | null} until
 * @property {boolean} untilPaid
 *
 * @typedef {VoidEvent | UpdateEvent | ArchiveEvent | ExceptionEvent | FreezeEvent} LedgerEvent
 */

/**
 * سجل الأحداث، الأحدث أولاً.
 * @param {Iterable<Op>} ops
 * @returns {LedgerEvent[]}
 */
export function eventsLog(ops) {
  const sorted = [...ops].sort(compareOps);
  /** @type {Map<string, {name: string, phone: string | null, cap: number | null}>} */
  const custs = new Map();
  /** @type {Map<string, {cid: string, kind: TxnKind, amount: number}>} */
  const txns = new Map();
  // نفس المراحل في reduce: العملاء أولاً حتى لا تضيع قيمة "قبل".
  for (const op of sorted) {
    if (op.type !== OP.CUSTOMER_CREATE) continue;
    const d = op.data;
    if (typeof d.cid !== 'string' || !d.cid || custs.has(d.cid)) continue;
    custs.set(d.cid, {
      name: String(d.name || '').trim(),
      phone: typeof d.phone === 'string' && d.phone.trim() ? d.phone.trim() : null,
      cap: Number.isInteger(d.cap) && d.cap > 0 ? d.cap : null,
    });
  }
  /** @type {LedgerEvent[]} */
  const out = [];
  for (const op of sorted) {
    const d = op.data;
    if (op.type === OP.TXN && typeof d.tid === 'string') {
      if (!txns.has(d.tid)) {
        txns.set(d.tid, { cid: d.cid, kind: d.kind, amount: d.amount });
        if (d.approved === true && d.kind === 'purchase') out.push({ id: op.id, ts: op.ts, type: 'txn.exception', cid: d.cid, tid: d.tid, kind: d.kind, amount: d.amount });
      }
    } else if (op.type === OP.CUSTOMER_UPDATE) {
      const c = custs.get(d.cid);
      if (!c) continue;
      /** @type {UpdateEvent['changes']} */
      const changes = [];
      if (typeof d.name === 'string' && d.name.trim() && d.name.trim() !== c.name) {
        changes.push({ field: 'name', from: c.name, to: d.name.trim() });
        c.name = d.name.trim();
      }
      if ('phone' in d) {
        const to = typeof d.phone === 'string' && d.phone.trim() ? d.phone.trim() : null;
        if (to !== c.phone) { changes.push({ field: 'phone', from: c.phone, to }); c.phone = to; }
      }
      if ('cap' in d) {
        const to = Number.isInteger(d.cap) && d.cap > 0 ? d.cap : null;
        if (to !== c.cap) { changes.push({ field: 'cap', from: c.cap, to }); c.cap = to; }
      }
      if (changes.length) out.push({ id: op.id, ts: op.ts, type: 'customer.update', cid: d.cid, changes });
    } else if (op.type === OP.CUSTOMER_FREEZE) {
      if (custs.has(d.cid)) out.push({ id: op.id, ts: op.ts, type: 'customer.freeze', cid: d.cid, frozen: !!d.frozen, until: typeof d.until === 'number' ? d.until : null, untilPaid: !!d.untilPaid });
    } else if (op.type === OP.CUSTOMER_ARCHIVE) {
      if (custs.has(d.cid)) out.push({ id: op.id, ts: op.ts, type: 'customer.archive', cid: d.cid, archived: !!d.archived });
    } else if (op.type === OP.TXN_VOID) {
      const t = txns.get(d.tid);
      if (!t) continue;
      out.push({
        id: op.id, ts: op.ts, type: 'txn.void', cid: t.cid, tid: d.tid, kind: t.kind, amount: t.amount,
        reason: typeof d.reason === 'string' && d.reason ? d.reason : null,
      });
    }
  }
  return out.reverse();
}
