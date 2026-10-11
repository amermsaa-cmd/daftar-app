// القفل: (1) قفل التطبيق ببصمة الجوال أو رمز فتحه نفسه عبر المتصفح، (2) رمز صاحب البقالة.
// ملاحظة: قفل الجوال حاجز دخول للتطبيق فقط، وليس تشفيراً للبيانات.

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/** هل الجوال فيه قفل شاشة (بصمة/رمز/نمط) يقدر المتصفح يستخدمه؟ */
export async function deviceLockAvailable() {
  try {
    return !!(window.PublicKeyCredential
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

/** تفعيل قفل التطبيق: يطلب من الجوال التحقق مرة، ويحفظ مفتاحاً محلياً. يرجع معرّف المفتاح أو null. */
export async function enableDeviceLock() {
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: rnd(32),
        rp: { name: 'دفتر الأجل' },
        user: { id: rnd(16), name: 'daftar', displayName: 'دفتر الأجل' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
      },
    });
    return cred ? b64(cred.rawId) : null;
  } catch { return null; }
}

/** فتح التطبيق: يظهر طلب البصمة أو رمز الجوال. @param {string} credId */
export async function unlockWithDevice(credId) {
  try {
    const r = await navigator.credentials.get({
      publicKey: {
        challenge: rnd(32),
        allowCredentials: [{ type: 'public-key', id: unb64(credId) }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!r;
  } catch { return false; }
}

// ----- رمز صاحب البقالة (4 أرقام، مخزّن كبصمة مملّحة) -----
async function derive(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, key, 256);
}

/** @param {string} pin @returns {Promise<{salt: string, hash: string}>} */
export async function hashPin(pin) {
  const salt = rnd(16);
  return { salt: b64(salt), hash: b64(await derive(pin, salt)) };
}

/** @param {string} pin @param {{salt: string, hash: string}} rec */
export async function checkPin(pin, rec) {
  if (!rec) return false;
  return b64(await derive(pin, unb64(rec.salt))) === rec.hash;
}
