# The mark

The letter, set in Times. Nothing more: at 16 pixels in a browser tab a drawn
illustration is a smudge, and a well-set letter is still a letter.

- `favicon.svg` — the source of truth, and what browsers use in a tab.
- `icon-192.png`, `icon-512.png` — the manifest's icons, declared `maskable`,
  so the letter sits inside the central 80% that Android will not crop.
- `apple-touch-icon.png` — 180px, because iOS will not take an SVG.

The PNGs are rasterised from the same design rather than drawn by hand:

```
# a 512x512 page containing the letter, screenshotted at each size
firefox --headless --window-size=512,512 --screenshot icon-512.png icons/render.html
```

`render.html` is not part of the app — nothing links it and the service worker
does not cache it. It lives here so that regenerating the PNGs is a command
rather than a guessing game. The font
stack names Times New Roman first and falls back through its metric-compatible
clones (Nimbus Roman, Liberation Serif), which is what a Linux or Android
machine will actually have.
