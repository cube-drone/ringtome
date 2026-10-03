// The drawing's navigator (Curtis, 2026-09-27), atop the layers column: a minimap of the whole
// drawing with a red square over the part the stage shows - drag the square, or press anywhere on
// the map, to look there - and under it (where Photoshop keeps it, and so Curtis's hands) zoom out,
// a zoom slider, zoom in. The stage is an ordinary scrolling box
// (doc/drawing.js), so a wheel or a trackpad pans it too, and the square follows.
//
// The arithmetic is pure/viewport.js; this measures, paints and listens.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import {
    MIN_ZOOM,
    MAX_ZOOM,
    FIT,
    SLIDER_STEPS,
    zoomIn,
    zoomOut,
    zoomToSlider,
    sliderToZoom,
    visibleFraction,
    scrollToCentre,
} from '../pure/viewport.js';

const html = htm.bind(h);

/// The stage as pure/viewport.js reads it, or null before it is on screen.
export function viewOf(stage, paper) {
    if (!stage || !paper) return null;
    return {
        scrollLeft: stage.scrollLeft,
        scrollTop: stage.scrollTop,
        clientWidth: stage.clientWidth,
        clientHeight: stage.clientHeight,
        paperLeft: paper.offsetLeft,
        paperTop: paper.offsetTop,
        paperWidth: paper.offsetWidth || 1,
        paperHeight: paper.offsetHeight || 1,
    };
}

/// `zoom` and `onZoom(z)` are the surface's; `stageRef` and `paperRef` the scrolling stage and the
/// drawing in it; `sourceRef` the stacked canvas the map is a small copy of.
export const Navigator = ({ zoom, onZoom, stageRef, paperRef, sourceRef, width, height }) => {
    const mapRef = useRef(null);
    const miniRef = useRef(null);
    const squareRef = useRef(null);
    const drag = useRef(null); // the grab's offset from the square's middle, while dragging

    // The red square, set straight on the element: it moves with every scroll, and re-rendering
    // the column for each would be waste.
    const place = () => {
        const view = viewOf(stageRef.current, paperRef.current);
        const square = squareRef.current;
        if (!view || !square) return;
        const f = visibleFraction(view);
        square.style.left = `${f.x * 100}%`;
        square.style.top = `${f.y * 100}%`;
        square.style.width = `${f.w * 100}%`;
        square.style.height = `${f.h * 100}%`;
    };
    useLayoutEffect(place);
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return undefined;
        stage.addEventListener('scroll', place, { passive: true });
        const watch = new ResizeObserver(place);
        watch.observe(stage);
        return () => {
            stage.removeEventListener('scroll', place);
            watch.disconnect();
        };
    }, [stageRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

    // The map: the stacked drawing, small - repainted every render (a small copy is cheap), so it is
    // there too when the column comes back from being tucked away.
    useEffect(() => {
        const mini = miniRef.current;
        const source = sourceRef.current;
        if (!mini || !source) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(mini.clientWidth * dpr));
        const h = Math.max(1, Math.round((w * height) / width));
        if (mini.width !== w || mini.height !== h) {
            mini.width = w;
            mini.height = h;
        }
        const ctx = mini.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(source, 0, 0, w, h);
    });

    const fractionAt = (e) => {
        const rect = mapRef.current.getBoundingClientRect();
        return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
    };
    const lookAt = (fx, fy) => {
        const stage = stageRef.current;
        const view = viewOf(stage, paperRef.current);
        if (!view) return;
        const to = scrollToCentre(view, fx, fy);
        stage.scrollLeft = to.left;
        stage.scrollTop = to.top;
    };
    const down = (e) => {
        const view = viewOf(stageRef.current, paperRef.current);
        if (!view || e.button > 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const [fx, fy] = fractionAt(e);
        const f = visibleFraction(view);
        const inside = fx >= f.x && fx <= f.x + f.w && fy >= f.y && fy <= f.y + f.h;
        // Held by the square: it moves with the pointer from where it was taken, not jumping its
        // middle under it. Pressed elsewhere: the view goes there, and the drag carries on from it.
        drag.current = inside ? [fx - (f.x + f.w / 2), fy - (f.y + f.h / 2)] : [0, 0];
        if (!inside) lookAt(fx, fy);
    };
    const move = (e) => {
        if (!drag.current) return;
        const [fx, fy] = fractionAt(e);
        lookAt(fx - drag.current[0], fy - drag.current[1]);
    };
    const up = () => {
        drag.current = null;
    };

    return html`<section class="drawing-nav">
        <div
            ref=${mapRef}
            class="drawing-nav-map drawing-floor"
            style=${`aspect-ratio: ${width} / ${height}`}
            title=${t('doc.navigator.map', 'drag the red square to look around')}
            onPointerDown=${down}
            onPointerMove=${move}
            onPointerUp=${up}
            onPointerCancel=${up}
        >
            <canvas ref=${miniRef} class="drawing-nav-mini"></canvas>
            <span ref=${squareRef} class="drawing-nav-view"></span>
        </div>
        <div class="drawing-nav-zoom">
            <button
                class="drawing-layer-eye"
                title=${t('doc.navigator.zoom-out', 'zoom out')}
                aria-label=${t('doc.navigator.zoom-out', 'zoom out')}
                disabled=${zoom <= MIN_ZOOM}
                onClick=${() => onZoom(zoomOut(zoom))}
            ><${Icons.zoomOut} /></button>
            <input
                type="range"
                min="0"
                max=${SLIDER_STEPS}
                value=${zoomToSlider(zoom)}
                aria-label=${t('doc.navigator.zoom', 'zoom')}
                onInput=${(e) => onZoom(sliderToZoom(+e.currentTarget.value))}
            />
            <button
                class="drawing-layer-eye"
                title=${t('doc.navigator.zoom-in', 'zoom in')}
                aria-label=${t('doc.navigator.zoom-in', 'zoom in')}
                disabled=${zoom >= MAX_ZOOM}
                onClick=${() => onZoom(zoomIn(zoom))}
            ><${Icons.zoomIn} /></button>
        </div>
        <button
            class="drawing-nav-fit"
            title=${t('doc.navigator.fit', 'fit the whole drawing on the stage')}
            disabled=${zoom === FIT}
            onClick=${() => onZoom(FIT)}
        >${t('doc.navigator.percent', '{percent}%', { percent: Math.round(zoom * 100) })}</button>
    </section>`;
};
