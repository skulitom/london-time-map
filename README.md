# London in minutes

**Live map: <https://skulitom.github.io/london-time-map/>**

A dark-mode map of London coloured by **travel time**. Pick a starting point (a station, a landmark,
a postcode, or any click on the map) and every part of the city is shaded from green (close) to red
(far). Tick boxes choose how you are willing to travel, and the colours update:

- 🚶 **By foot**: unlimited walking at 5 km/h. With this off, walking is limited to 20 minutes to or from a stop.
- 🚇 **Underground**: Tube and DLR.
- 🚆 **Trains**: Elizabeth line, Overground, National Rail and tram.
- 🚌 **Buses**: every TfL bus route, stop by stop.
- 🚗 **Car**: door-to-door driving at daytime speeds, plus time to fetch and park the car.

Walking is not a straight line: it runs on a 150 m grid where water blocks the way and only
pedestrian bridges and foot tunnels cross it, so the south bank really is further away than it looks.
Hover any station or landmark for its time and route. The URL hash records the start point and modes,
so views can be shared. An experimental "stretch the map by time" option turns the same numbers into a
time-space map (places move to sit as many minutes from the start as it takes to reach them).

It is a static site: no server, no API keys, no build step for the page itself. Postcode lookups use
the free [postcodes.io](https://postcodes.io) API.

## Run it locally

Any static file server works (ES modules need `http://`, not `file://`):

```bash
node scripts/dev-server.mjs 8000
```

then open <http://localhost:8000>. That server sends `no-store`, so edits always show up on reload;
`python -m http.server 8000` serves the site just as well if you would rather not use Node.

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` (or run the *Deploy to GitHub Pages* workflow manually). The workflow in
   `.github/workflows/deploy.yml` publishes the repository root.

The site then lives at `https://<user>.github.io/<repo>/`. Everything is loaded with relative
paths, so it works from a sub-path.

If you prefer "Deploy from a branch", that works too: choose the `main` branch and `/ (root)`.
The `.nojekyll` file keeps GitHub from running Jekyll on the files.

## How it works

The page draws everything itself on a canvas with [D3](https://d3js.org) (projection, zoom). Each
time the start point or the tick boxes change:

1. **One shortest-path search** (`src/engine.js`) runs over a graph that joins the walking grid
   (`src/walkgrid.js`, about 143,000 cells) with one platform node per stop and line. Walking moves
   between neighbouring cells; boarding costs the line's typical wait; rides follow the real stop
   sequences with a dwell plus distance at the mode's speed; alighting returns to the grid. Car trips
   are computed directly from distance with speeds that slow towards the centre. The whole search
   takes a fraction of a second.
2. **Colour bands** are the filled contours of the resulting travel-time surface
   (`src/contours.js`: the same rings `d3.contours` traces, found in a fraction of the time), clipped
   to Greater London and tinted onto the land.
3. **Stations and landmarks** take the time of their grid cell; hovering one walks the search tree
   back to the start to show the legs.

The travel-time model is deliberately simple and documented in `src/model.js`: typical waits per
mode, dwell time plus cruising speed per hop for rail and bus, and walking and driving speeds. It is
meant to show the *shape* of London in time, not to replace a journey planner.

### Keeping it smooth

The map holds a lot of geometry: 33 borough outlines, the Thames and 345 other water bodies, 65
parks, 787 trunk and motorway runs, 34 rail lines, about 25,000 bus links and 916 labelled places.
Almost all of what a frame of that costs is rasterisation, which the browser does after the drawing
calls have returned (Chrome does it on the GPU process), so it never shows up in a JavaScript
profile: a pan frame that took 2 ms of script used to take 85 ms to rasterise, even on a fast
graphics card. These rules keep it cheap:

- **Nothing is drawn twice.** Every input to the picture goes into one key; if the key matches the
  last frame, `draw()` returns without touching the canvas. An idle map runs no timers and repaints
  nothing.
- **The map and labels are compositor layers.** Land, colour bands, water, roads and the bus and
  rail networks are rendered into a padded canvas; stations, places and labels are cached in a
  second canvas. Panning moves both using CSS transforms without copying the whole map or
  rasterising its text each frame. A stationary transparent canvas receives input and draws only
  the changing hover route. Zooming scales the layers, which are rendered sharp again once the
  zoom has been still for 150 ms. Label collisions use a spatial grid to check nearby labels.
  Everything drawn over the colour bands is kept in a transparent overlay as well, so a new start
  point or tick box repaints only the land and the bands beneath it. A pan that runs past the margin
  moves the pixels the layer already has and renders only the strip it uncovered, and a fresh layer
  renders the part in the window first and its margin over the following frames.
- **Paths stay small.** Chrome rasterises a stroked path that spans the screen many times more slowly
  than the same lines cut into pieces a hundred or so pixels across, so the bus network and the roads
  are drawn in chunks sized to the zoom level and chunks out of view are skipped. National Rail
  dashes are laid out in script rather than by the canvas, which dashes every line from end to end
  however little of it is on screen. For the same reason each part of the layer draws only the rings
  and lines that reach into it: Chrome does the work of a whole path, whatever the clip lets through.
- **Paths are built once.** Geometry lives in base coordinates, with the bounding box of every ring
  and line, and whole `Path2D` objects are re-used under the canvas transform. Only the colour bands
  are rebuilt when the times change.
- **Recalculation runs in a worker.** Changing the start point or a tick box sends the search,
  surface and contours to `src/routing-worker.js`, leaving the page free to respond. Only the
  latest request is applied; rapid changes keep at most one active calculation and one pending
  request. Typed buffers are transferred back and the result is displayed together. If a worker
  cannot start, the same calculator runs locally as a fallback.
- **Interactions share animation frames.** Slider and resize events are coalesced, hover routes
  pause during navigation, and zoom controls interrupt an unfinished zoom instead of queuing it.
  Reduced-motion preferences skip animated zoom and stretch transitions. The loading animation
  stops once the first result is ready.

The search supports keyboard suggestions (arrow keys, Enter and Escape) and cancels stale postcode
lookups. Focus the map to pan with arrow keys, zoom with `+`/`-`, or reset with Home. On smaller
screens, controls start collapsed so the map is visible; choosing a starting point closes them again.

Driving times are only integrated where a car could actually win: the cheapest conceivable drive is
the fixed overhead plus the straight line at top speed, and any place already reached sooner by
another mode skips the integral. That is an exact shortcut, not an approximation.

Loading follows the same idea. `index.html` preloads the data files and the modules, so they
download alongside D3 instead of after it, and it loads only the parts of D3 the map uses
(projection, zoom with its transitions, Delaunay): 47 KB on the wire rather than 76 KB for the whole
library. The bulk of `data/transit.json` and `data/base.json` (stops, platforms, hops and every
coordinate) is stored as delta-encoded integers (`src/data.js`), which cuts the two from 718 KB to
286 KB gzipped and makes them quicker to parse.

### Verification

Run `npm test` for calculation regression, request handling, worker fallback and label collisions.
They use Node's built-in test runner and require no dependencies. The page itself still has no
build step. For the browser regression checks (Node 20+), run `npm install` and `npx playwright install chromium`,
start the local server, then run `npm run test:browser`. Set `TEST_URL` for a different server or
`BROWSER_EXECUTABLE` to use an existing Chrome installation. These checks cover layer reuse while
dragging and hovering, cache invalidation, long pans, zoom, stretch, resizing and idle rendering.

## Data

`scripts/build-data.mjs` regenerates the files in `data/`:

```bash
node scripts/build-data.mjs
```

It caches every remote response in `scripts/cache/` (ignored by git), so re-runs are offline; delete a
cache file to refresh that source. A first run fetches about 700 bus routes from TfL and takes a few
minutes.

| File | Contents | Source |
| --- | --- | --- |
| `data/transit.json` | Lines, stops, stations, platforms and stop-to-stop hops for rail and every bus route; rail route geometry. Stops, platforms and hops are stored as delta-encoded columns (`src/data.js`) | [TfL Unified API](https://api.tfl.gov.uk) |
| `data/walkgrid.json` | Walkable-cell mask (water minus bridges and foot tunnels) and a Greater London mask, bit-packed | OpenStreetMap water areas and bridges, ONS boundaries |
| `data/base.json` | Borough boundaries, River Thames, other water bodies, major parks, motorways and trunk roads, as delta-encoded runs of points (`src/data.js`) | [ONS Open Geography Portal](https://geoportal.statistics.gov.uk), [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass |
| `data/places.json` | About 120 landmarks and town centres with label priority | `scripts/places.json`, hand-curated |

Contains OS data © Crown copyright and database right; ONS boundaries are licensed under the
Open Government Licence v3. Map data © OpenStreetMap contributors, ODbL. Transport data powered by
TfL Open Data.

## License

The code is released under the [MIT License](LICENSE). The generated files in `data/` remain
subject to the terms of their sources listed above.
