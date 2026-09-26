# Branding

Horse Drawing Tycoon 2's own pictures (README's *Two names*: the app is Horse Drawing Tycoon 2, the
protocol under it Ringtome).

| file | what |
|---|---|
| `hdt_logo.kra`, `hdt_logo.png` | the logo: the horse in its purple ring. The source of every icon. 256×256, which is as large as it was drawn |
| `hdt_logo_1024.png` | the logo scaled to 1024 (Lanczos), margins as drawn: the source for Windows, Linux and web icons |
| `hdt_logo_1024_macos.png` | the logo at 824 on a transparent 1024 canvas - Apple's icon grid, so it sits at the same size as its neighbours in the Dock: the source for `icon.icns` only |
| `hdt_2_banner.kra`, `hdt_2_banner.png` | the banner, 1024×768: a README / website / release-page picture, not an icon |

## Remaking the icons

After changing the logo, regenerate everything from it (Pillow in a throwaway virtualenv; nothing
here installs it):

```sh
python3 -m venv /tmp/pv && /tmp/pv/bin/pip install pillow
/tmp/pv/bin/python - <<'PY'
from PIL import Image
src = Image.open('branding/hdt_logo.png').convert('RGBA')
src.resize((1024, 1024), Image.LANCZOS).save('branding/hdt_logo_1024.png', optimize=True)
padded = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
padded.alpha_composite(src.resize((824, 824), Image.LANCZOS), (100, 100))
padded.save('branding/hdt_logo_1024_macos.png', optimize=True)
tight = Image.open('branding/hdt_logo_1024.png').convert('RGBA')
tight.save('node/html/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
touch = Image.new('RGBA', (180, 180), (0xf6, 0xef, 0xe0, 255))   # iOS paints transparency black
touch.alpha_composite(tight.resize((160, 160), Image.LANCZOS), (10, 10))
touch.convert('RGB').save('node/html/apple-touch-icon.png', optimize=True)
PY
# The desktop app's whole set, then the Mac's own from the padded master. `tauri icon` also writes
# android/ and ios/, which this app does not have.
npx @tauri-apps/cli@2 icon branding/hdt_logo_1024.png -o desktop/icons
npx @tauri-apps/cli@2 icon branding/hdt_logo_1024_macos.png -o /tmp/hdt-icons-mac
cp /tmp/hdt-icons-mac/icon.icns desktop/icons/icon.icns
rm -rf desktop/icons/android desktop/icons/ios
```

The web icons are baked into the node binary (`node/src/ui.rs`), so a rebuild picks them up.
