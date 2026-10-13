// اشتراك الجوال: النواة المشتركة (packages/core/src/license.js) + رمز جهاز عشوائي ثابت + تخزين في IndexedDB.
// التحقق من التوقيع بمكتبة tweetnacl (متزامنة وتعمل على كل الأجهزة). الكود نفسه يعمل بدون إنترنت.
import nacl from './vendor/nacl.js';
import { createLicenseManager, rawPublicKey, randomDeviceCode } from './core/index.js';

/**
 * يحمّل الحالة المحفوظة (ويُنشئ رمز الجهاز أول مرة) ثم يُرجع مدير الاشتراك.
 * @param {{now?: () => number, publicKey?: Uint8Array, store: {getMeta: (k: string, d?: any) => Promise<any>, setMeta: (k: string, v: any) => Promise<void>}}} o
 */
export async function initLicense({ now = () => Date.now(), store, publicKey = undefined }) {
  let deviceCode = await store.getMeta('deviceCode');
  if (!deviceCode) {
    deviceCode = randomDeviceCode(crypto.getRandomValues(new Uint8Array(8)));
    await store.setMeta('deviceCode', deviceCode);
  }
  /** @type {any} */
  const st = Object.assign({ code: '', maxIssued: 0, lastSeen: 0 }, await store.getMeta('lic', {}));
  const pub = publicKey || rawPublicKey();
  const mgr = createLicenseManager({
    machine: deviceCode, now,
    verify: (msg, sig) => /** @type {any} */ (nacl).sign.detached.verify(msg, sig, pub),
    storage: {
      get: () => st,
      set: (patch) => { Object.assign(st, patch); store.setMeta('lic', { ...st }).catch(() => {}); },
    },
  });
  return { ...mgr, deviceCode };
}
