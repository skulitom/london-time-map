// Travel-time model: constants and formulas. Times are minutes, distances metres.

export const MODES = [
  { id: 'foot', label: 'By foot', icon: '🚶', hint: '5 km/h, any distance' },
  { id: 'underground', label: 'Underground', icon: '🚇', hint: 'Tube and DLR' },
  { id: 'trains', label: 'Trains', icon: '🚆', hint: 'Rail, Overground, tram' },
  { id: 'bus', label: 'Buses', icon: '🚌', hint: 'Slow in the centre' },
  { id: 'car', label: 'Car', icon: '🚗', hint: 'Daytime traffic, plus parking' },
];

// Which tick box governs each TfL mode.
export const GROUP_OF_MODE = {
  tube: 'underground',
  dlr: 'underground',
  'elizabeth-line': 'trains',
  overground: 'trains',
  'national-rail': 'trains',
  tram: 'trains',
  bus: 'bus',
};

// Charing Cross, the traditional centre of London. Road speeds depend on distance from here.
export const CENTRE = { lat: 51.5074, lon: -0.1278 };

// Walking: 5 km/h along streets that are ~25% longer than the straight line, so 1 km ≈ 15 min.
// Without the "By foot" box ticked, walking is limited to short legs (getting to and from stations).
// On the walking grid (see walkgrid.js) paths already bend around water, so a smaller street
// detour factor applies to each grid step.
export const WALK = { speed: 5000 / 60, detour: 1.25, gridDetour: 1.2, accessLimit: 20, maxRadius: 4500, maxNeighbours: 40 };
export const walkMinutes = (d) => (d * WALK.detour) / WALK.speed;
export const walkStepMinutes = (cellMetres) => (cellMetres * WALK.gridDetour) / WALK.speed;

// Travel-time colour bands: green for close, red for far.
export const BANDS = [
  { max: 10, colour: '#2fbf71' },
  { max: 20, colour: '#8fd14f' },
  { max: 30, colour: '#d4e157' },
  { max: 45, colour: '#ffd54f' },
  { max: 60, colour: '#ffab40' },
  { max: 90, colour: '#ff7043' },
  { max: 120, colour: '#e53935' },
  { max: Infinity, colour: '#8e1c2c' },
];
export const BAND_THRESHOLDS = [0, 10, 20, 30, 45, 60, 90, 120]; // lower edge of each band
export const UNREACHABLE_COLOUR = '#3a3f4a';
export function bandColour(t) {
  if (!Number.isFinite(t)) return UNREACHABLE_COLOUR;
  for (const b of BANDS) if (t <= b.max) return b.colour;
  return BANDS[BANDS.length - 1].colour;
}

// Rail: each hop between adjacent stations costs a dwell plus track distance at cruising speed.
export const RIDE = {
  tube: { dwell: 0.6, speed: 12 * 60 },
  dlr: { dwell: 0.6, speed: 11 * 60 },
  overground: { dwell: 0.7, speed: 15 * 60 },
  'elizabeth-line': { dwell: 0.7, speed: 21 * 60 },
  'national-rail': { dwell: 0.8, speed: 25 * 60 },
  tram: { dwell: 0.5, speed: 10 * 60 },
};
export const RAIL_DETOUR = 1.1;
export const PLATFORM_ACCESS = 1.5; // street to platform, added to the line's typical wait
export const PLATFORM_EXIT = 1;
export const HUB_INTERCHANGE = 3; // walking between platforms of one interchange hub
export function rideMinutes(mode, d) {
  const r = RIDE[mode] || RIDE['national-rail'];
  return r.dwell + (d * RAIL_DETOUR) / r.speed;
}

// Buses follow their real TfL routes stop by stop. Each hop costs a dwell plus the road distance at a
// speed that rises from 11 km/h in the centre to 20 km/h in the suburbs; the wait is per boarding.
export const BUS = { dwell: 0.2, hopDetour: 1.15 };
export const busSpeedKmh = (rCentre) => Math.min(22, 12 + 1.4 * (rCentre / 1000));
export function hopMinutes(mode, metres, rCentre) {
  if (mode === 'bus') return BUS.dwell + (metres * BUS.hopDetour) / ((busSpeedKmh(rCentre) * 1000) / 60);
  return rideMinutes(mode, metres);
}

// Car: fetch the car and park it (6 min), and drive at daytime speeds that ease off outside the centre.
// Speed is integrated along the straight line between the two points (in metres from Charing Cross),
// so a trip through the middle is slow in the middle and quicker on the way out.
export const CAR = { overhead: 6, detour: 1.25, samples: 8, topSpeedKmh: 60 };
export function carSpeedKmh(rCentre) {
  const km = rCentre / 1000;
  if (km < 3) return 16;
  if (km < 8) return 16 + ((km - 3) / 5) * 14;
  if (km < 16) return 30 + ((km - 8) / 8) * 15;
  return Math.min(CAR.topSpeedKmh, 45 + ((km - 16) / 8) * 15);
}
// The quickest a drive could possibly be: overhead plus the whole way at the top speed. Lets the
// caller skip the integral below for places that some other mode already reaches sooner.
export const CAR_MINUTES_PER_METRE = CAR.detour / ((CAR.topSpeedKmh * 1000) / 60);
export const carFloorMinutes = (d) => CAR.overhead + d * CAR_MINUTES_PER_METRE;
export function carMinutes(ox, oy, x, y) {
  const d = Math.hypot(x - ox, y - oy);
  if (d < 40) return 0;
  const n = CAR.samples;
  let minutes = 0;
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    const rc = Math.hypot(ox + (x - ox) * t, oy + (y - oy) * t);
    minutes += ((d / n) * CAR.detour) / ((carSpeedKmh(rc) * 1000) / 60);
  }
  return CAR.overhead + minutes;
}

export const RING_MINUTES = [10, 20, 30, 45, 60, 90, 120, 180];
