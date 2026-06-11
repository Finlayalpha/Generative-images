# Particle Lenia — a living wallpaper

A hands-off, **perpetually moving** generative wallpaper built on **Particle
Lenia** (Mordvintsev et al., Google Research) — a particle-based descendant of
Conway's Game of Life. One self-contained file (`index.html`), **no
dependencies, fully offline**, **no controls or settings** — it just runs.
Built to be a MacBook screensaver / live wallpaper.

## Why particles (and not a grid)

Grid-based Lenia / SmoothLife settle into static spatial patterns — spots,
labyrinths — because every cell relaxes to a steady value and the lattice
locks into a fixed point. **Particle Lenia removes the grid entirely.** It
simulates a fixed set of particles whose motion is a *gradient flow* on an
energy field, so the particles are intrinsically moving and self-organize into
living "cells" that drift, rotate, merge and split. A static lattice simply
isn't a state the system can occupy, so it never freezes.

For each particle *i*:

```
U_i  = Σ_j K(|p_i − p_j|)                 Lenia field (ring kernel K)
E(x) = R(x) − G(U(x))                      energy = repulsion − growth
  K(r) = w_k · exp(−((r−μ_k)/σ_k)²)
  G(u) = exp(−((u−μ_g)/σ_g)²)
  R(x) = (c_rep/2) · Σ_j max(1 − |x−p_j|, 0)²
dp_i/dt = −∇E(p_i)                         move down the energy gradient
```

Defaults are Google Research's: `μ_k=4, σ_k=1, w_k=0.022, μ_g=0.6, σ_g=0.15,
c_rep=1, dt=0.1`.

**Active matter so it never crystallizes.** Pure gradient-flow Particle Lenia
eventually descends into a low-energy jammed foam and stops changing. To keep it
permanently alive, each particle also *self-propels* along a slowly-wandering
heading (`v0`, `turn`). Active matter is physically incapable of reaching
equilibrium, so the cells perpetually swim, collide, merge and split. Verified
headless over ~4000 steps: cohesion holds (`meanU` steady) while the
configuration keeps reorganizing at a constant rate (no settling).

## Look

- **Static heatmap** — denser mass reads "hotter": black → indigo → crimson →
  orange → yellow → white (inferno-style ramp), as in the Particle Lenia demos.
- Particles are drawn as additive glow splats into a float buffer, then the heat
  ramp is applied — giving smooth, organic, luminous "cells".
- Pauses when the tab/window is hidden.

## How it's built

- **Simulation** runs on the CPU with a spatial hash for O(N) neighbour queries
  (the kernel is short-range), on a torus so structures wrap around forever.
  Verified headless: stable (no blow-up), `meanU → μ_g`, and motion never stops.
- **Rendering** is WebGL2: additive point-sprite glow → `R16F` accumulation →
  heatmap colour pass.

## Run it on macOS

The file is offline-first: once it's on disk it never touches the network.

### As a screensaver — [WebViewScreenSaver](https://github.com/liquidx/webviewscreensaver) (free, open source)

1. Install WebViewScreenSaver from its releases page.
2. System Settings → **Screen Saver** → **WebViewScreenSaver** → *Options*.
3. Add a URL pointing at this file on disk, e.g.
   `file:///Users/yourname/Generative-images/index.html` (run `pwd` here and
   append `/index.html`).

### As a live desktop wallpaper — [Plash](https://github.com/sindresorhus/Plash) (free)

1. Install Plash.  2. **Open URL…** → the same `file://…/index.html` path.
3. Set *Bring browsing level to back* so it sits behind your icons.

### Just to preview

Double-click `index.html` and use your browser's full-screen shortcut.

## Tuning (edit the `CONFIG` block at the top of `index.html`)

- `nParticles` — more = denser, more cells (also heavier on the CPU).
- `worldHeight` — world size in Lenia units; smaller = larger cells on screen.
- `substeps` — sim steps per frame; more = livelier motion (heavier).
- `noise` — thermal jitter; keeps it churning, prevents any freeze.
- `look.pointSize` — glow radius (fraction of screen height).
- `look.gain` / `gamma` — maps mass density onto the heat ramp (brightness/contrast).
- `mu_k, sigma_k, w_k, mu_g, sigma_g, c_rep, dt` — the Particle Lenia rule itself.

## Credits / further reading

- Particle Lenia — Mordvintsev et al., Google Research:
  <https://google-research.github.io/self-organising-systems/particle-lenia/>
- Lenia — Bert Chan: <https://chakazul.github.io/lenia.html>
- Conway's Game of Life: <https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life>
