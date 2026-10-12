// @ts-check
// المزامنة مع سيرفر دفتر الأجل. لا تلمس الواجهة، وتأخذ كل ما تحتاجه من الخارج فتُختبر بسهولة.
//
// الفكرة: الدفتر عمليات فقط (إضافة فقط). المزامنة = (1) نسحب من السيرفر العمليات التي ننقصها ونضيفها للدفتر،
// (2) نرسل للسيرفر العمليات التي لم يستلمها بعد. السيرفر يتجاهل المكرر، والدفتر يتجاهل المكرر،
// فلا يضيع شيء ولا يتكرر شيء حتى لو انقطع الاتصال في أي لحظة.

export const SYNC_URL = 'https://daftar.karam-zone.com';
const BATCH = 400;

/**
 * @typedef {object} SyncStore  تخزين حالة المزامنة على الجهاز
 * @property {() => number} getCursor      آخر موضع سحبناه من السيرفر
 * @property {(n: number) => Promise<void>} setCursor
 * @property {() => Set<string>} getPushed  معرّفات العمليات التي يعرفها السيرفر
 * @property {(ids: string[]) => Promise<void>} addPushed
 *
 * @typedef {'idle' | 'syncing' | 'offline' | 'unauthorized' | 'disabled' | 'error'} SyncState
 */

/**
 * فحص المفتاح قبل الربط.
 * @param {string} baseUrl @param {string} key @param {typeof fetch} fetchFn
 * @returns {Promise<'ok' | 'unauthorized' | 'disabled' | 'offline' | 'error'>}
 */
export async function verifyKey(baseUrl, key, fetchFn) {
  try {
    const res = await fetchFn(`${baseUrl}/v1/ops?limit=1`, { headers: { Authorization: `Bearer ${key.trim()}` } });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'unauthorized';
    if (res.status === 403) return 'disabled';
    return 'error';
  } catch { return 'offline'; }
}

export class SyncClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl
   * @param {string} o.key
   * @param {import('../../../packages/core/src/index.js').Ledger} o.ledger
   * @param {SyncStore} o.store
   * @param {typeof fetch} o.fetchFn
   * @param {(added: number) => Promise<void>} [o.onPulled]  تُستدعى بعد إضافة عمليات من السيرفر (لحفظها وإعادة العرض)
   */
  constructor({ baseUrl, key, ledger, store, fetchFn, onPulled = async () => {} }) {
    this.baseUrl = baseUrl;
    this.key = key.trim();
    this.ledger = ledger;
    this.store = store;
    this.fetchFn = fetchFn;
    this.onPulled = onPulled;
    /** @type {SyncState} */
    this.state = 'idle';
    this.lastSyncAt = 0;
    this.rejected = 0;
    this._running = false;
    this._again = false;
  }

  /** عدد العمليات التي لم تُرسل بعد. */
  pending() {
    const pushed = this.store.getPushed();
    let n = 0;
    for (const id of this.ledger.opIds()) if (!pushed.has(id)) n++;
    return n;
  }

  /** @param {string} path @param {RequestInit} [init] */
  async _req(path, init = {}) {
    const res = await this.fetchFn(this.baseUrl + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${this.key}` } });
    if (res.status === 401) throw Object.assign(new Error('unauthorized'), { state: 'unauthorized' });
    if (res.status === 403) throw Object.assign(new Error('disabled'), { state: 'disabled' });
    if (!res.ok) throw Object.assign(new Error('http-' + res.status), { state: 'error' });
    return res.json();
  }

  async _pull() {
    for (;;) {
      const r = await this._req(`/v1/ops?after=${this.store.getCursor()}&limit=500`);
      if (r.ops.length) {
        const { added } = this.ledger.merge(r.ops);
        await this.store.addPushed(r.ops.map((/** @type {{id: string}} */ o) => o.id));
        if (added.length) await this.onPulled(added.length);
      }
      await this.store.setCursor(r.cursor);
      if (!r.more) return;
    }
  }

  async _push() {
    for (;;) {
      const pushed = this.store.getPushed();
      const todo = this.ledger.allOps().filter((op) => !pushed.has(op.id)).slice(0, BATCH);
      if (!todo.length) return;
      const r = await this._req('/v1/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: todo }),
      });
      this.rejected += (r.rejected || []).length;
      // المرفوضة (تالفة أو كبيرة جداً) لا نعيد إرسالها بلا نهاية
      await this.store.addPushed(todo.map((op) => op.id));
    }
  }

  /** مزامنة كاملة. استدعاءات متداخلة تُدمج في جولة واحدة إضافية. @returns {Promise<SyncState>} */
  async sync() {
    if (this._running) { this._again = true; return this.state; }
    this._running = true;
    this.state = 'syncing';
    try {
      do {
        this._again = false;
        await this._pull();
        await this._push();
      } while (this._again);
      this.state = 'idle';
      this.lastSyncAt = Date.now();
    } catch (e) {
      const err = /** @type {any} */ (e);
      this.state = err && err.state ? err.state : (err instanceof TypeError ? 'offline' : 'error');
    } finally {
      this._running = false;
    }
    return this.state;
  }
}

/**
 * حالة الإشعارات التلقائية: هل الجسر حيّ، وحالة رسائل العمليات الأخيرة.
 * @param {string} baseUrl @param {string} key @param {typeof fetch} fetchFn
 * @returns {Promise<{bridge: {alive: boolean, lastSeen: number, waOk: boolean}, items: {op: string, status: string, at: number}[]} | null>}
 */
export async function notifyStatus(baseUrl, key, fetchFn) {
  try {
    const res = await fetchFn(`${baseUrl}/v1/notify/status`, { headers: { Authorization: `Bearer ${key.trim()}` } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * يأخذ الموظف رسالة العملية يدوياً. ok=false يعني أن الجسر أرسلها أو يرسلها الآن (فلا نكررها).
 * يرجع null لو تعذّر الاتصال (فنكمل يدوياً دون منع الموظف).
 * @param {string} baseUrl @param {string} key @param {string} tid @param {typeof fetch} fetchFn
 * @returns {Promise<{ok: boolean, status: string | null} | null>}
 */
export async function claimManual(baseUrl, key, tid, fetchFn) {
  try {
    const res = await fetchFn(`${baseUrl}/v1/notify`, {
      method: 'POST', headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: tid, status: 'manual' }),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * حالة ربط واتساب: {state, phone, req, qr, code, bridgeAlive} أو null عند تعذّر الاتصال
 * @param {string} baseUrl @param {string} key @param {typeof fetch} fetchFn
 * @returns {Promise<any>}
 */
export async function linkStatus(baseUrl, key, fetchFn) {
  try {
    const res = await fetchFn(`${baseUrl}/v1/wa/link`, { headers: { Authorization: `Bearer ${key.trim()}` } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * طلب من التطبيق للجسر: mode = code (مع phone) | qr | unlink
 * @param {string} baseUrl @param {string} key @param {{mode: string, phone?: string}} body @param {typeof fetch} fetchFn
 */
export async function linkRequest(baseUrl, key, body, fetchFn) {
  try {
    const res = await fetchFn(`${baseUrl}/v1/wa/link`, { method: 'POST', headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  } catch { return false; }
}

