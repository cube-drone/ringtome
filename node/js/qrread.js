// Reading a QR code out of a picture (Curtis, 2026-10-20): the spare key's code, photographed off
// the ceremony's screen (persona.js), brought back to the recovery form. The browser's own
// BarcodeDetector where it has one - Chrome on Android and the Mac - and jsQR everywhere else,
// over the picture shrunk to a few sizes: a phone's twelve megapixels are slow to search and
// no easier to read.
import jsQR from 'jsqr';

/// The longest side jsQR searches, largest first.
const SIDES = [1600, 1000, 600];

/// What the QR code in `file` (an image) says, or null when none is found. The picture is opened
/// as an ordinary <img>, which every webview decodes, the desktop app's on Linux included.
export async function readQr(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        if ('BarcodeDetector' in window) {
            try {
                const found = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(
                    img,
                );
                if (found.length > 0) return found[0].rawValue;
            } catch {
                // no QR support after all: jsQR below
            }
        }
        const longest = Math.max(width, height);
        for (const side of SIDES) {
            const scale = Math.min(1, side / longest);
            const w = Math.max(1, Math.round(width * scale));
            const hgt = Math.max(1, Math.round(height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = hgt;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, w, hgt);
            const code = jsQR(ctx.getImageData(0, 0, w, hgt).data, w, hgt, {
                inversionAttempts: 'attemptBoth',
            });
            if (code && code.data) return code.data;
            if (scale === 1) break; // already whole: a smaller copy says no more
        }
        return null;
    } finally {
        URL.revokeObjectURL(url);
    }
}
