# Lenia — a living wallpaper

A hands-off, endlessly running generative wallpaper built on **Lenia**, the
continuous generalization of Conway's Game of Life. One self-contained file
(`index.html`), **no dependencies, fully offline**, **no controls or settings** —
it just runs. Built to be a MacBook screensaver / live wallpaper.

## What it does

It seeds a school of real Lenia **lifeforms**, lets them swim and wrap around
the screen, then slowly cycles through a zoo of different creatures forever,
while the colour drifts gently through the spectrum.

- **Real creatures, seeded** — Orbium, Scutium, Discutium, Parorbium (from Bert
  Chan's collection), embedded as run-length-encoded patterns and decoded at load.
- **A school that glides** — copies are stamped with a shared orientation so they
  travel together on a torus (wrap-around), rather than colliding into mush.
- **Slow cycling** — every ~30s it fades to black, switches creature, and reseeds.
- **Tasteful colour** — a single accent colour (black → accent → white-hot cores)
  that slowly rotates hue over minutes. No garish per-pixel rainbow.
- **Light** — runs a small simulation grid and upscales with smooth bicubic
  filtering, so it stays easy on the GPU. Pauses when the tab/window is hidden.

## Why the creatures are seeded (not "emergent")

Lenia's gliders look emergent in videos, but they aren't reliably so: random
"soup" almost always relaxes into a **static Turing pattern**. The famous
lifeforms occupy a tiny corner of parameter space and are found by deliberate
search/evolution, then **seeded** as specific patterns. So this wallpaper embeds
the real patterns and plays them, which is how those videos are actually made.
(See the notes/links at the bottom.)

## Run it on macOS

The file is offline-first: once it's on disk it never touches the network.

### As a screensaver — [WebViewScreenSaver](https://github.com/liquidx/webviewscreensaver) (free, open source)

1. Download and install WebViewScreenSaver from its releases page.
2. System Settings → **Screen Saver** → choose **WebViewScreenSaver** → *Options*.
3. Add a URL pointing at this file on disk, e.g.
   `file:///Users/yourname/Generative-images/index.html`
   (run `pwd` in this folder and append `/index.html`).

### As a live desktop wallpaper — [Plash](https://github.com/sindresorhus/Plash) (free)

1. Install Plash (Mac App Store or GitHub).
2. Plash menu → **Open URL…** → enter the same `file://…/index.html` path.
3. Set *Bring browsing level to back* so it sits behind your icons.

### Just to preview

Double-click `index.html` to open it in Safari/Chrome/Firefox, then use your
browser's full-screen shortcut.

## Tuning (optional — edit the `CONFIG` block at the top of `index.html`)

- `simLongAxis` — sim resolution on the long side. **Smaller = bigger creatures
  and lighter on the GPU**; larger = more, smaller creatures.
- `cycleSec` — seconds each creature is shown before switching.
- `seedCount` — how many creatures make up the school.
- `look.hueSpeed` — how fast the colour drifts (1/240 ≈ a full cycle every 4 min).
- `look.gain` / `gamma` / `glow` / `vignette` — brightness, glow and framing.

To add more creatures, append `{ name, m, s, cells }` entries to `CREATURES`
(single-kernel `R=13` creatures from Chan's collection drop straight in).

## Notes

- Requires **WebGL2** + float textures (any recent Safari/Chrome/Firefox on a
  modern Mac). A message is shown if unavailable.
- Creature patterns are decoded from Chan's RLE "cells" format; values are 0–255
  mapped to 0–1.

## Credits / further reading

- Lenia — Bert Wang-Chak Chan: <https://chakazul.github.io/lenia.html> ·
  creature data: <https://github.com/Chakazul/Lenia>
- "Soup settles into Turing patterns; creatures are rare and seeded":
  <https://arxiv.org/pdf/2510.00794> · Lenia paper: <https://arxiv.org/pdf/1812.05433>
- Conway's Game of Life: <https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life>
