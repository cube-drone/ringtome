// The colour picker (Curtis, 2026-09-26: "a nice RGB selecting triangle"): a hue ring with an HSV
// triangle inside it, the GIMP / Krita picker, plus a hex field for typing a colour exactly. Drag
// the ring to turn the hue - the triangle turns with it, its bright corner pointing at the hue - and
// drag in the triangle for how saturated and how light. The geometry and the colour arithmetic are
// pure/colour.js; this paints them and listens.
//
// Painted per pixel on a canvas backed at the screen's density: the ring once (it never changes),
// the triangle once per hue, the two markers every move. The two painters are exported because they
// only fill pixel buffers - which lets their output be looked at outside a browser.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import {
    hexToRgb,
    rgbToHex,
    rgbToHsv,
    hsvToRgb,
    triangleCorners,
    hueAt,
    onRing,
    svToPoint,
    pointToSv,
} from '../pure/colour.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// The picker's size on screen, and the ring's thickness, in CSS pixels.
const SIZE = 172;
const RING = 16;

const geometry = () => {
    const c = SIZE / 2;
    const outer = c - 2;
    const inner = outer - RING;
    return { c, outer, inner, tri: inner - 4 };
};

export function paintRing(ctx, dpr) {
    const { c, outer, inner } = geometry();
    const n = Math.round(SIZE * dpr);
    const img = ctx.createImageData(n, n);
    for (let py = 0; py < n; py++) {
        for (let px = 0; px < n; px++) {
            const x = (px + 0.5) / dpr;
            const y = (py + 0.5) / dpr;
            const d = Math.hypot(x - c, y - c);
            // A soft pixel at each edge, so the ring is round rather than stepped.
            const alpha = Math.max(0, Math.min(1, outer - d + 0.5, d - inner + 0.5));
            if (alpha <= 0) continue;
            const [r, g, b] = hsvToRgb({ h: hueAt(x, y, c, c), s: 1, v: 1 });
            const i = (py * n + px) * 4;
            img.data[i] = r;
            img.data[i + 1] = g;
            img.data[i + 2] = b;
            img.data[i + 3] = alpha * 255;
        }
    }
    return img;
}

export function paintTriangle(ctx, dpr, hue) {
    const { c, tri } = geometry();
    const corners = triangleCorners(hue, c, c, tri);
    const [hr, hg, hb] = hsvToRgb({ h: hue, s: 1, v: 1 });
    const n = Math.round(SIZE * dpr);
    const img = ctx.createImageData(n, n);
    const { hue: A, white: B, black: C } = corners;
    const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    const lo = Math.floor((c - tri) * dpr);
    const hi = Math.ceil((c + tri) * dpr);
    for (let py = lo; py < hi; py++) {
        for (let px = lo; px < hi; px++) {
            const x = (px + 0.5) / dpr;
            const y = (py + 0.5) / dpr;
            const a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / det;
            const b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / det;
            const k = 1 - a - b;
            const edge = Math.min(a, b, k);
            if (edge < -0.01) continue;
            const i = (py * n + px) * 4;
            img.data[i] = a * hr + b * 255;
            img.data[i + 1] = a * hg + b * 255;
            img.data[i + 2] = a * hb + b * 255;
            img.data[i + 3] = Math.max(0, Math.min(1, (edge + 0.01) * 60)) * 255;
        }
    }
    return img;
}

function marker(ctx, x, y, radius, light) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = light ? '#ffffff' : '#000000';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = light ? '#000000' : '#ffffff';
    ctx.stroke();
}

/// `value` is `#rrggbb`; `onChange(hex)` fires as the colour moves.
export const ColourPicker = ({ value, onChange }) => {
    const canvasRef = useRef(null);
    const cache = useRef({ ring: null, triangle: null, triangleHue: null, dpr: 0 });
    const drag = useRef(null); // 'hue' | 'sv' | null
    // The picker keeps its own HSV, because a grey has no hue: turning a colour to grey and back
    // must not snap the ring to red.
    const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(value) || [0, 0, 0]));
    const [typed, setTyped] = useState(value);
    const hex = rgbToHex(hsvToRgb(hsv));

    // A colour set from outside - a swatch, another drawing's brush - moves the picker, keeping the
    // hue it had when the new colour has none of its own.
    useEffect(() => {
        setTyped(value);
        if (!value || value === hex) return;
        const rgb = hexToRgb(value);
        if (!rgb) return;
        const next = rgbToHsv(rgb);
        setHsv(next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next);
    }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

    const set = (next) => {
        setHsv(next);
        const out = rgbToHex(hsvToRgb(next));
        setTyped(out);
        if (out !== value) onChange(out);
    };

    // Paint: the cached ring and triangle, then the markers.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const n = Math.round(SIZE * dpr);
        if (canvas.width !== n) {
            canvas.width = canvas.height = n;
        }
        const ctx = canvas.getContext('2d');
        const k = cache.current;
        if (k.dpr !== dpr) {
            k.ring = paintRing(ctx, dpr);
            k.triangle = null;
            k.dpr = dpr;
        }
        if (k.triangleHue !== hsv.h || !k.triangle) {
            k.triangle = paintTriangle(ctx, dpr, hsv.h);
            k.triangleHue = hsv.h;
        }
        // The two layers composite through a scratch canvas: putImageData ignores alpha blending.
        const scratch = document.createElement('canvas');
        scratch.width = scratch.height = n;
        const sctx = scratch.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, n, n);
        sctx.putImageData(k.ring, 0, 0);
        ctx.drawImage(scratch, 0, 0);
        sctx.clearRect(0, 0, n, n);
        sctx.putImageData(k.triangle, 0, 0);
        ctx.drawImage(scratch, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { c, outer, inner, tri } = geometry();
        const mid = (outer + inner) / 2;
        const rad = (hsv.h * Math.PI) / 180;
        marker(ctx, c + mid * Math.cos(rad), c + mid * Math.sin(rad), RING / 2 - 2, false);
        const [sx, sy] = svToPoint(hsv, triangleCorners(hsv.h, c, c, tri));
        marker(ctx, sx, sy, 5, hsv.v < 0.55);
    }, [hsv]);

    const at = (e) => {
        const rect = canvasRef.current.getBoundingClientRect();
        return [((e.clientX - rect.left) * SIZE) / rect.width, ((e.clientY - rect.top) * SIZE) / rect.height];
    };
    const apply = (x, y) => {
        const { c, tri } = geometry();
        if (drag.current === 'hue') set({ ...hsv, h: hueAt(x, y, c, c) });
        else if (drag.current === 'sv') set({ ...hsv, ...pointToSv([x, y], triangleCorners(hsv.h, c, c, tri)) });
    };
    const down = (e) => {
        const [x, y] = at(e);
        const { c, outer, inner } = geometry();
        if (onRing(x, y, c, c, inner - 2, outer + 2)) drag.current = 'hue';
        else if (Math.hypot(x - c, y - c) < inner) drag.current = 'sv';
        else return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(x, y);
    };
    const move = (e) => {
        if (drag.current) apply(...at(e));
    };
    const up = () => {
        drag.current = null;
    };

    return html`<div class="colour-picker">
        <canvas
            ref=${canvasRef}
            class="colour-picker-wheel"
            style=${`width: ${SIZE}px; height: ${SIZE}px`}
            onPointerDown=${down}
            onPointerMove=${move}
            onPointerUp=${up}
            onPointerCancel=${up}
            aria-label=${t('doc.colourpicker.hue-and-shade', 'hue ring and shade triangle')}
        ></canvas>
        <div class="colour-picker-row">
            <span class="colour-picker-now" style=${`background: ${hex}`}></span>
            <input
                class="colour-picker-hex"
                value=${typed}
                spellcheck=${false}
                aria-label=${t('doc.colourpicker.hex', 'colour as hex')}
                onInput=${(e) => {
                    const v = e.currentTarget.value;
                    setTyped(v);
                    const rgb = hexToRgb(v);
                    if (rgb) {
                        const next = rgbToHsv(rgb);
                        set(next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next);
                    }
                }}
            />
        </div>
    </div>`;
};
