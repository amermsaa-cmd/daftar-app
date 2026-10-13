// نسخ Google Drive مباشرة من الجوال (الباقة الأساسية بلا سيرفر).
// الإذن مؤقت (نحو ساعة) بطبيعة Google للتطبيقات بلا سيرفر، فتُطلب الموافقة عند كل نسخة (نقرتان).
// الصلاحية drive.file فقط: يرى التطبيق مجلد «دفتر الأجل» الذي ينشئه ولا يرى بقية ملفات المستخدم.
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER = 'دفتر الأجل';
export const KEEP_DAYS = 30;
const API = 'https://www.googleapis.com';
const GSI = 'https://accounts.google.com/gsi/client';

/** تاريخ اليوم بتوقيت الرياض YYYY-MM-DD @param {number} ts */
export const riyadhDay = (ts) => new Date(ts + 3 * 3600 * 1000).toISOString().slice(0, 10);

// ===== Google Identity Services (طلب الإذن) =====
/** @type {Promise<void> | null} */ let gsiP = null;
function loadGsi() {
  if (gsiP) return gsiP;
  gsiP = new Promise((resolve, reject) => {
    if (/** @type {any} */ (globalThis).google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = GSI; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gsiP = null; reject(new Error('net')); };
    document.head.appendChild(s);
  });
  return gsiP;
}

/** @type {any} */ let tokenClient = null;
/** @type {{resolve: (t: string) => void, reject: (e: Error) => void} | null} */ let waiting = null;
let token = '', tokenUntil = 0;

/**
 * تجهيز مسبق (قبل الضغط) حتى يُستدعى طلب الإذن داخل نقرة المستخدم مباشرة فلا يحجبه المتصفح.
 * @param {() => Promise<string>} getClientId
 */
export async function prepare(getClientId) {
  if (tokenClient) return true;
  await loadGsi();
  const clientId = await getClientId();
  if (!clientId) throw new Error('not-configured');
  tokenClient = /** @type {any} */ (globalThis).google.accounts.oauth2.initTokenClient({
    client_id: clientId, scope: SCOPE,
    callback: (/** @type {any} */ r) => {
      const w = waiting; waiting = null; if (!w) return;
      if (r && r.access_token) { token = r.access_token; tokenUntil = Date.now() + (Number(r.expires_in) || 3000) * 1000 - 60000; w.resolve(token); }
      else w.reject(new Error(r && r.error ? String(r.error) : 'denied'));
    },
    error_callback: (/** @type {any} */ e) => { const w = waiting; waiting = null; if (w) w.reject(new Error(e && e.type === 'popup_closed' ? 'canceled' : (e && e.type) || 'denied')); },
  });
  return true;
}
export const isReady = () => !!tokenClient;

/** يجب أن يُستدعى مباشرة من نقرة. إن كان الإذن الحالي ما زال صالحاً يُعاد دون نافذة. @returns {Promise<string>} */
export function requestToken() {
  if (token && Date.now() < tokenUntil) return Promise.resolve(token);
  if (!tokenClient) return Promise.reject(new Error('not-ready'));
  return new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

// ===== واجهة Drive =====
/**
 * @param {string} tok @param {typeof fetch} f
 * @param {string} url @param {RequestInit} [init]
 */
async function gfetch(tok, f, url, init = {}) {
  const r = await f(url, { ...init, headers: { Authorization: 'Bearer ' + tok, ...(init.headers || {}) } });
  if (!r.ok) { const e = new Error('drive-' + r.status); /** @type {any} */ (e).status = r.status; throw e; }
  return r;
}
const qstr = (/** @type {string} */ s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** @param {string} tok @param {typeof fetch} f @returns {Promise<string>} */
async function ensureFolder(tok, f) {
  const q = `name='${qstr(FOLDER)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await (await gfetch(tok, f, `${API}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`)).json();
  if (r.files && r.files[0]) return r.files[0].id;
  const c = await (await gfetch(tok, f, `${API}/drive/v3/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).json();
  return c.id;
}

/**
 * يرفع نسخة اليوم (تُحدَّث خلال اليوم) في مجلد «دفتر الأجل» ويحذف الأقدم من 30 يوماً.
 * @param {{token: string, json: string, now?: number, fetchFn?: typeof fetch}} o
 * @returns {Promise<{name: string, deleted: number}>}
 */
export async function uploadBackup({ token: tok, json, now = Date.now(), fetchFn = (u, i) => fetch(u, i) }) {
  const f = fetchFn;
  const folder = await ensureFolder(tok, f);
  const name = `daftar-${riyadhDay(now)}.json`;
  const q = `'${folder}' in parents and trashed=false and name contains 'daftar-'`;
  const list = await (await gfetch(tok, f, `${API}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200`)).json();
  const files = list.files || [];
  const same = files.find((/** @type {any} */ x) => x.name === name);
  if (same) {
    await gfetch(tok, f, `${API}/upload/drive/v3/files/${same.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json });
  } else {
    const boundary = 'daftar' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [folder], mimeType: 'application/json' });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
    await gfetch(tok, f, `${API}/upload/drive/v3/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  }
  // تنظيف الأقدم من 30 يوماً (لا يفشل النسخ إن فشل التنظيف)
  const cutoff = riyadhDay(now - KEEP_DAYS * 86400000);
  let deleted = 0;
  for (const x of files) {
    const m = /^daftar-(\d{4}-\d{2}-\d{2})\.json$/.exec(x.name);
    if (m && m[1] < cutoff) { try { await gfetch(tok, f, `${API}/drive/v3/files/${x.id}`, { method: 'DELETE' }); deleted++; } catch { /* نتجاهل */ } }
  }
  return { name, deleted };
}
