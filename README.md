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
python -m http.server 8000
```

then open <http://localhost:8000>.

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

The page draws everything itself on a canvas with [D3](https://d3js.org) (projection, contours,
zoom). Each time the start point or the tick boxes change:

1. **One shortest-path search** (`src/engine.js`) runs over a graph that joins the walking grid
   (`src/walkgrid.js`, about 143,000 cells) with one platform node per stop and line. Walking moves
   between neighbouring cells; boarding costs the line's typical wait; rides follow the real stop
   sequences with a dwell plus distance at the mode's speed; alighting returns to the grid. Car trips
   are computed directly from distance with speeds that slow towards the centre. The whole search
   takes a fraction of a second.
2. **Colour bands** are the filled contours of the resulting travel-time surface
   (`d3.contours`), clipped to Greater London and tinted onto the land.
3. **Stations and landmarks** take the time of their grid cell; hovering one walks the search tree
   back to the start to show the legs.

The travel-time model is deliberately simple and documented in `src/model.js`: typical waits per
mode, dwell time plus cruising speed per hop for rail and bus, and walking and driving speeds. It is
meant to show the *shape* of London in time, not to replace a journey planner.

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
| `data/transit.json` | Lines, stops, stations, platforms and stop-to-stop hops for rail and every bus route; rail route geometry | [TfL Unified API](https://api.tfl.gov.uk) |
| `data/walkgrid.json` | Walkable-cell mask (water minus bridges and foot tunnels) and a Greater London mask, bit-packed | OpenStreetMap water areas and bridges, ONS boundaries |
| `data/base.json` | Borough boundaries, River Thames, other water bodies, major parks, motorways and trunk roads | [ONS Open Geography Portal](https://geoportal.statistics.gov.uk), [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass |
| `data/places.json` | About 120 landmarks and town centres with label priority | `scripts/places.json`, hand-curated |

Contains OS data © Crown copyright and database right; ONS boundaries are licensed under the
Open Government Licence v3. Map data © OpenStreetMap contributors, ODbL. Transport data powered by
TfL Open Data.

## License

The code is released under the [MIT License](LICENSE). The generated files in `data/` remain
subject to the terms of their sources listed above.
