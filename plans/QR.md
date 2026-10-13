# QR codes - a person or a post, from one phone to another

A design draft (2026-10-12), with rulings.

## The ask (Curtis, 2026-10-12)

"QR codes, everywhere. On the right side of your identity banner? A QR code that
automatically opens in the HDT android app (if installed) and points to your
identity, or opens the current website (if FQDN is available) and points to your
identity. (Maybe "FQDN first, app second" is the easier order to build). Every
public document? A file chip, with the phosphor "qr-code" logo, that brings up a
QR code that'll do the same: point to the FQDN of this content if available or
navigate to this content in your local copy of HDT if available."

## Rulings (Curtis, 2026-10-12)

1. **A node with no public URL still shows a QR: one only the app opens.** Two
   people with the app can swap a person or a post face to face with no website
   between them. That takes a link scheme of our own, which PROJECT_PLAN set
   aside on 2026-07-31 (_The three slots_) because no native app existed to
   answer it. The Android app is that app now.
2. **The app opens a web QR by a button on the web page**, not by Android's
   verified links: those work only for domains written into the app, and every
   node has its own. On an Android phone outside the app, a person's page and a
   post's page offer "open in Horse Drawing Tycoon 2", which hands the address
   to the app. One tap more than a verified link, for every node alike.

## What a QR says

The shortest address the node can vouch for, the same one "copy link" hands out
(plans/WEB_ADDRESSES.md, _When the path is used_):

- **A node with a public URL**: the whole web address. A person:
  `https://horsedrawingtycoon.com/@cube-drone` where this node gave them that
  name, else `…/ringtome/user/<base58 root>`. A post: its path form under the
  @name, else under the identity, else `…/post/<hex>`. No `?via=`: the website
  serves the page itself, and every hint makes the code denser.
- **A node without one**: the app's address, `ringtome://` and the identity path
  after `/ringtome/` -
  `ringtome://user/<base58 root>/post/<hex>?via=<node key>`. One `via`, this
  node's own key, so the scanning app knows whom to ask. The post's never-moving
  id rather than its path: the path form is resolved through the node that holds
  it, and the id resolves anywhere. The scheme is `ringtome`, not the app's
  name: it's a protocol string (_Two names_).

What decides between them is the rule "copy link" and the address row already
follow: a person's web address only for a persona this node serves, a post's
wherever the node declares a public URL.

## How it's drawn

`qrcode-generator` (MIT, no dependencies) turns the words into modules; the page
draws them as one SVG path, dark on a light plate whatever the colourway, since
scanners want dark on light. Error correction M. Two places:

- **The person page**: the code itself, small, on the right of the banner's top
  row beside the RSS mark. Pressed, it opens big in the house modal with the
  address under it in words.
- **A public post**: a chip with Phosphor's `QrCode`, beside "link", opening the
  same modal.

## Opening in the app

- **The scheme**: the Android app answers `ringtome://` (an intent filter on
  `MainActivity`). The address it's handed becomes a path on its own node,
  `/ringtome/` and the rest, and the page goes there - as a pasted address
  rehomes today. The page asks for it on starting
  (`window.__ringtomeLink.take()`), and is told when one arrives while it runs.
- **The web page's button**: on Android, outside the app, the person page and a
  post's page show "open in Horse Drawing Tycoon 2": an `intent://` link naming
  the app's package and the same address, which Chrome hands to the app if it's
  installed and otherwise leaves the page where it is.

## Slices

1. **The code** - the QR on the person page and the chip on public posts, with
   both kinds of address.
2. **The app** - the scheme in the Android app, and the web page's button. A CI
   build and a phone.

## Left for later

- The desktop app answering `ringtome://` too (Tauri's deep-link plugin).
- Scanning inside the app, for a phone whose camera won't hand an unknown scheme
  on.
