// التخزين الدائم على الجوال (IndexedDB): سجل العمليات + الإعدادات المحلية للجهاز.
// الإعدادات المحلية (القفل، رمز صاحب البقالة، المظهر) لا تُزامَن مع أجهزة أخرى.

// وضع التدريب: دفتر منفصل تماماً باسم قاعدة مختلف (لا يلمس الدفتر الحقيقي).
export function isTraining() { try { return localStorage.getItem('daftar.train') === '1'; } catch { return false; } }
export function setTraining(on) { try { if (on) localStorage.setItem('daftar.train', '1'); else localStorage.removeItem('daftar.train'); } catch { /* ignore */ } }
const NAME = isTraining() ? 'daftar-train' : 'daftar';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

/** @param {string} store @param {'readonly'|'readwrite'} mode @param {(s: IDBObjectStore) => IDBRequest | void} fn */
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const loadOps = () => tx('ops', 'readonly', (s) => s.getAll());

export async function putOps(ops) {
  if (!ops.length) return;
  await tx('ops', 'readwrite', (s) => { for (const op of ops) s.put(op); });
}

export async function getMeta(k, fallback = null) {
  const row = await tx('meta', 'readonly', (s) => s.get(k));
  return row ? row.v : fallback;
}

export async function setMeta(k, v) {
  await tx('meta', 'readwrite', (s) => { s.put({ k, v }); });
}

export async function delMeta(k) {
  await tx('meta', 'readwrite', (s) => { s.delete(k); });
}

/** طلب التخزين الدائم حتى لا يمسح الجوال البيانات عند ضيق المساحة. */
export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return 'unsupported';
    if (await navigator.storage.persisted()) return 'granted';
    return (await navigator.storage.persist()) ? 'granted' : 'denied';
  } catch { return 'unsupported'; }
}

export async function persistenceStatus() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return 'unsupported';
    return (await navigator.storage.persisted()) ? 'granted' : 'denied';
  } catch { return 'unsupported'; }
}

/** مسح دفتر التدريب كاملاً (عند إنهاء التدريب). */
export function wipeTraining() {
  return new Promise((resolve) => {
    const go = () => { const r = indexedDB.deleteDatabase('daftar-train'); r.onsuccess = r.onerror = r.onblocked = () => resolve(undefined); };
    if (dbp) dbp.then((d) => { d.close(); go(); }, go); else go();
  });
}
