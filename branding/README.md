# Branding

Horse Drawing Tycoon 2's own pictures (README's _Two names_: the app is Horse
Drawing Tycoon 2, the protocol under it Ringtome).

| file                                   | what                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hdt_logo_2.kra`, `hdt_logo_2.png`     | the logo (2026-10-08): five blue strokes - a triangle, a zigzag, a ring and two squares. 300×300, as drawn                                                                                  |
| `hdt_logo_2.svg`                       | the same, traced (below): five paths, one per stroke, in the logo's blue. The source of every icon, and of the tab icon the app paints in each colourway's colours (`node/js/pure/logo.js`) |
| `hdt_logo_1024.png`                    | the SVG rendered at 1024, margins as drawn: the source for Windows, Linux and web icons                                                                                                     |
| `hdt_logo_1024_macos.png`              | the SVG at 824 on a transparent 1024 canvas - Apple's icon grid, so it sits at the same size as its neighbours in the Dock: the source for `icon.icns` only                                 |
| `hdt_logo.kra`, `hdt_logo.png`         | the first logo, the horse in its purple ring - kept, no longer used                                                                                                                         |
| `hdt_2_banner.kra`, `hdt_2_banner.png` | the banner, 1024×768: a README / website / release-page picture, not an icon                                                                                                                |

## Remaking the icons

After changing the logo, trace it, then regenerate everything from the SVG
(Pillow, numpy, scipy, potracer and resvg in a throwaway virtualenv; nothing
here installs them). The trace upscales the PNG's alpha 4× and softens it a
little - the brush's grain is lost at icon sizes and bloats the path. Then it
parts the strokes: the ring and the right square touch in the drawing, so the
mask is eroded until five pieces stand apart and each pixel goes back to the
nearest piece, which splits them along where they meet. Each stroke is traced
alone with potrace, to one path with its hole. The strokes go to three places,
which a pure test holds together (`node/integration/test/pure/logo.cjs`):
`branding/hdt_logo_2.svg`, `node/html/favicon.svg` and `STROKES` in
`node/js/pure/logo.js`, in the order triangle, zigzag, ring, left square, right
square.

```sh
python3 -m venv /tmp/pv && /tmp/pv/bin/pip install pillow numpy scipy potracer resvg-py
/tmp/pv/bin/python - <<'PY'
import io, numpy as np, potrace, resvg_py
from PIL import Image, ImageFilter
from scipy import ndimage as ndi
src = Image.open('branding/hdt_logo_2.png').convert('RGBA')
alpha = src.getchannel('A').resize((1200, 1200), Image.LANCZOS).filter(ImageFilter.GaussianBlur(3))
mask = np.array(alpha) > 110
seeds, n = ndi.label(ndi.binary_erosion(mask, iterations=10))       # five pieces, apart
_, (iy, ix) = ndi.distance_transform_edt(seeds == 0, return_indices=True)
labels = np.where(mask, seeds[iy, ix], 0)                           # each pixel to the nearest
f = lambda p: f"{p.x / 4:.1f} {p.y / 4:.1f}"
def trace(bits):                                                     # potracer traces False pixels
    curves = potrace.Bitmap(~bits).trace(turdsize=40, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY,
                                         alphamax=1.0, opticurve=True, opttolerance=0.8)
    return ''.join(f"M{f(c.start_point)}" + ''.join(
        f"L{f(s.c)}L{f(s.end_point)}" if s.is_corner else f"C{f(s.c1)} {f(s.c2)} {f(s.end_point)}"
        for s in c.segments) + 'Z' for c in curves)
def where(k):                                                        # which stroke a piece is
    ys, xs = np.nonzero(labels == k)
    cy, cx, w = ys.mean() / 4, xs.mean() / 4, (xs.max() - xs.min()) / 4
    return ('triangle' if cy < 70 and w < 60 else 'zigzag' if cy < 100 else 'ring' if cy < 150
            else 'left-square' if cx < 150 else 'right-square')
strokes = {where(k): trace(labels == k) for k in range(1, n + 1)}
order = ['triangle', 'zigzag', 'ring', 'left-square', 'right-square']
svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' + ''.join(
    f'<path fill="#0008ff" fill-rule="evenodd" d="{strokes[k]}"/>' for k in order) + '</svg>'
for out in ('branding/hdt_logo_2.svg', 'node/html/favicon.svg'):
    open(out, 'w').write(svg)
print('now put the five d strings into STROKES in node/js/pure/logo.js')
render = lambda n: Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=n, height=n)))).convert('RGBA')
render(1024).save('branding/hdt_logo_1024.png', optimize=True)
padded = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
padded.alpha_composite(render(824), (100, 100))
padded.save('branding/hdt_logo_1024_macos.png', optimize=True)
render(256).save('node/html/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
touch = Image.new('RGBA', (180, 180), (0xf6, 0xef, 0xe0, 255))   # iOS paints transparency black
touch.alpha_composite(render(160), (10, 10))
touch.convert('RGB').save('node/html/apple-touch-icon.png', optimize=True)
PY
# The desktop app's whole set, then the Mac's own from the padded master. `tauri icon` also writes
# android/ and ios/, which this app does not have.
npx @tauri-apps/cli@2 icon branding/hdt_logo_1024.png -o desktop/icons
npx @tauri-apps/cli@2 icon branding/hdt_logo_1024_macos.png -o /tmp/hdt-icons-mac
cp /tmp/hdt-icons-mac/icon.icns desktop/icons/icon.icns
rm -rf desktop/icons/android desktop/icons/ios
```

The web icons are baked into the node binary (`node/src/ui.rs`), so a rebuild
picks them up. (vtracer, tried first, segfaulted on the mask; potracer is pure
Python and slow - a few seconds - but sure.)
