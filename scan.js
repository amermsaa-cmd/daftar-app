// مسح بطاقة العميل بكاميرا الجوال بدون مكتبات: BarcodeDetector المدمج في كروم على أندرويد.
// بطاقات النظام القديم Code128 (CUST-0085)، والجديدة D-XXXXXXXX.

export function scanSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && 'BarcodeDetector' in window);
}

/**
 * يفتح الكاميرا داخل `host` ويرجع نص أول باركود يُقرأ (أو null لو أُغلق).
 * @param {HTMLElement} host
 * @returns {Promise<string | null>}
 */
export async function scanOnce(host) {
  const detector = new window.BarcodeDetector({ formats: ['code_128', 'qr_code', 'code_39', 'ean_13'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  const box = document.createElement('div');
  box.className = 'scanner';
  box.innerHTML = `<video playsinline muted></video><div class="frame"></div>
    <div class="cap">وجّه الكاميرا نحو باركود بطاقة العميل</div>
    <button type="button" class="btn x">إغلاق</button>`;
  host.appendChild(box);
  const video = /** @type {HTMLVideoElement} */ (box.querySelector('video'));
  video.srcObject = stream;
  await video.play().catch(() => {});

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      box.remove();
      resolve(value);
    };
    box.querySelector('.x')?.addEventListener('click', () => finish(null));
    const timer = setInterval(async () => {
      if (video.readyState < 2) return;
      try {
        const found = await detector.detect(video);
        if (found.length && found[0].rawValue) finish(found[0].rawValue);
      } catch { /* إطار غير جاهز */ }
    }, 250);
  });
}
