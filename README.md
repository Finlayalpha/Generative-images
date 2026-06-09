# Generative — a living wallpaper

An endlessly evolving, GPU-light generative artwork inspired by Conway's Game
of Life. One self-contained file (`index.html`), **no dependencies, fully
offline**. Built to be a MacBook screensaver / live wallpaper.

## The idea: the fewest rules, the most beauty

Conway's Game of Life is gorgeous but blocky — it's *discrete* in space (a grid),
state (alive/dead), and time (ticks), so it tends to freeze into static junk.
The natural way to make it fluid and endlessly alive is to make all three
**continuous**. That generalization already exists: **Lenia** (Bert Chan, 2018).

Lenia collapses to essentially **one update rule**:

1. **Convolve** the field with a ring-shaped kernel (a smooth neighbourhood).
2. Pass the result through **one** smooth, bell-shaped *growth* function.
3. Add a sliver of that back to the field.

Tune three numbers (kernel radius, growth centre `μ`, growth width `σ`) and you
get smooth, swimming, morphing "lifeforms." Game of Life itself is just one
special parameter setting of this — so Lenia is the honest answer to *"what is
the minimum number of rules for the maximally beautiful result?"*

The project also ships **Gray-Scott reaction–diffusion** (two coupled equations →
coral / Turing patterns) as a one-line alternative. Both run entirely on the GPU
with ping-pong float textures, so they're very light.

## What makes it bright, fluid and high-fidelity

- Runs the simulation at a fraction of screen resolution and upscales with
  linear filtering — fluid motion, low cost.
- A cheap **bloom/glow** pass gives bright regions a luminous, high-fidelity feel.
- **Endless by design:** it periodically drops fresh "soup," so the world never
  dies and never freezes.

## Colour, speed & character follow the clock and calendar (offline)

Everything below reads `new Date()` — no network required:

| Reads | Drives |
| --- | --- |
| Time of day | Palette phase + warmth (cool at night → warm at midday) |
| Time of day | Brightness (dims after dark, bright by day) |
| Time of day | **Simulation speed** (calmer at night, faster around midday) |
| Day of year (season) | Extra palette rotation across the year |
| Day of year (season) | Nudges Lenia's growth centre, so the creatures change character through the seasons |
| Battery (laptops) | Throttles FPS when unplugged and low, to save power |

All of these are tunable in the `CONFIG.systemData` block.

## Run it on macOS

The file is offline-first: once it's on disk it never touches the network.

### As a screensaver — [WebViewScreenSaver](https://github.com/liquidx/webviewscreensaver) (free, open source)

1. Download and install WebViewScreenSaver from its releases page.
2. System Settings → **Screen Saver** → choose **WebViewScreenSaver** → *Options*.
3. Add a URL pointing at this file on disk, e.g.
   `file:///Users/yourname/Generative-images/index.html`
   (find the exact path by running `pwd` in this folder and appending `/index.html`).

### As a live desktop wallpaper — [Plash](https://github.com/sindresorhus/Plash) (free)

1. Install Plash (Mac App Store or GitHub).
2. Plash menu → **Open URL…** → enter the same `file://…/index.html` path.
3. Set *Bring browsing level to back* so it sits behind your icons.

### Just to preview

Double-click `index.html` to open it in Safari/Chrome/Firefox, then use your
browser's full-screen shortcut.

## Customise it

Open `index.html` and edit the `CONFIG` object at the top. Highlights:

- `rule: 'lenia'` → switch to `'gray-scott'` for coral/Turing patterns.
- `simScale`, `maxSimDim`, `maxDPR`, `fps` → performance vs. fidelity.
- `lenia: { R, dt, kmu, ksig, gmu, gsig }` → the creatures' size, speed and
  behaviour. `gmu`/`gsig` are the heart of it; small changes matter.
- `grayScott: { F, k, ... }` → try `(0.0367, 0.0649)` for mitosis, or
  `(0.014, 0.054)` for waves.
- `look: { gain, gamma, exposure, glow, vignette }` → brightness and bloom.
- `systemData` → how the clock/calendar/battery drive colour, speed, etc.
  Set `enabled: false` for a constant look.

### Live controls (handy while tuning)

A hint bar appears on screen on load and whenever you press a key.

- <kbd>G</kbd> — switch system (Lenia ⇄ Gray-Scott)
- <kbd>P</kbd> — cycle presets for the current system
- <kbd>C</kbd> — cycle colour palettes
- <kbd>S</kbd> — toggle the date/time effects (off by default)
- <kbd>R</kbd> — reseed everything
- <kbd>Space</kbd> — pause / resume
- <kbd>H</kbd> — show / hide the hint bar

Found a combination you like? Set it as the startup default via `CONFIG.rule`,
`CONFIG.leniaPreset` / `CONFIG.gsPreset`, and `CONFIG.palette`.

## Notes

- Requires a browser with **WebGL2** and float render targets (any recent
  Safari, Chrome, or Firefox on a modern Mac). A message is shown if unavailable.
- The visual was tuned by hand; if Lenia ever looks too sparse or too busy on
  your machine, nudge `lenia.gmu` by ±0.005 or switch `rule` to `'gray-scott'`.

## Credits / further reading

- Lenia — Bert Wang-Chak Chan: <https://chakazul.github.io/lenia.html> ·
  <https://en.wikipedia.org/wiki/Lenia>
- Conway's Game of Life: <https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life>
- Gray-Scott reaction–diffusion: <https://www.karlsims.com/rd.html>
- Cosine palettes — Inigo Quilez: <https://iquilezles.org/articles/palettes/>
