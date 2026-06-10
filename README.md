# SmoothLife — a living wallpaper

A hands-off, **endlessly churning** generative wallpaper built on **SmoothLife**,
Stephan Rafler's continuous generalization of Conway's Game of Life. One
self-contained file (`index.html`), **no dependencies, fully offline**, **no
controls or settings** — it just runs. Built to be a MacBook screensaver / live
wallpaper.

## What it does

It runs a continuous cellular automaton from random soup. Complex dynamics
emerge on their own — the field churns perpetually and **gliders are born,
swim, and dissolve** without being seeded or choreographed. A slow, tasteful
colour drift plays over the top.

- **Genuinely emergent** — unlike most Lenia regimes (which settle into static
  Turing patterns), this SmoothLife parameter set never settles. Lifeforms arise
  from the dynamics themselves.
- **Never dies** — runs on a torus (wrap-around), and a gentle "rain" of fresh
  soup keeps new activity appearing forever.
- **Tasteful colour** — a single accent colour (black → accent → white-hot cores)
  that slowly rotates hue over minutes. No garish per-pixel rainbow.
- **Light** — a small simulation grid upscaled with smooth bicubic filtering;
  pauses when the tab/window is hidden.

## Why SmoothLife (and not seeded Lenia)?

Lenia's famous gliders rarely *emerge* — random soup almost always relaxes into
a static Turing pattern, so the iconic creatures usually have to be seeded as
specific patterns (which looks choreographed). **SmoothLife**, its sibling, has
parameter regimes that churn perpetually and spit out gliders on their own —
which is what an "alive forever" screensaver actually wants.

How it works each step: for every cell it measures two smooth neighbourhood
averages — the fill of an inner disk (radius `ri`, "am I alive?") and of an
outer ring (`ri..ra`, "how crowded am I?") — then a smooth birth/survival rule
`s(n,m)` nudges the cell up or down via `f += dt·(2·s − 1)`.

The parameters are the verified glider-producing transition set (Rafler /
tsoding): `b1=0.257, b2=0.336, d1=0.365, d2=0.549, αn=0.028, αm=0.147`.

**Room matters most.** If the grid is only a few glider-widths across, the whole
field locks into one global standing pattern (the labyrinth) instead of hosting
separate gliders. So we keep the radius modest (`ra=12`) and the grid large
(`simLongAxis=480` → ~40 glider-widths) — and a regular "rain" of fresh soup
keeps it churning. On a narrow window (e.g. a phone in portrait) there's less
room, so it's happiest full-screen on a wide display.

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

- `simLongAxis` — sim resolution on the long side. **Smaller = bigger features
  and lighter on the GPU.** (The kernel cost grows with `ra²`, so if it's heavy,
  lower this before touching `ra`.)
- `ri` / `ra` — neighbourhood radii (keep `ra ≈ 3·ri`). Bigger = larger lifeforms,
  but too small and gliders dissolve.
- `dt` — timestep. Too large collapses to a static state; too small barely moves.
- `rainSec` / `rainCount` — how often / how much fresh soup is stirred in.
- `look.hueSpeed` — colour drift rate (1/240 ≈ a full cycle every 4 min).

## Notes

- Requires **WebGL2** + float textures (any recent Safari/Chrome/Firefox on a
  modern Mac). A message is shown if unavailable.

## Credits / further reading

- SmoothLife — Stephan Rafler: <https://arxiv.org/pdf/1111.1567>
- Reference shader (parameters): <https://github.com/tsoding/SmoothLife>
- Lenia (sibling system) — Bert Chan: <https://chakazul.github.io/lenia.html>
- On glider sensitivity to resolution/step size: <https://arxiv.org/pdf/2401.13111>
- Conway's Game of Life: <https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life>
