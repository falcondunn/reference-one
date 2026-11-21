// The studio's curve rules (website/app/js/studio/curves.mjs): the grid, REW's RMS average, the
// placement rules today's Graph tab followed, and the L/R figures. V4_APP_DIR names the app's
// folder; tests/test_website_app.py sets it and runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const APP = pathToFileURL(process.env.V4_APP_DIR.replace(/[\\/]*$/, "/"));
const C = await import(new URL("js/studio/curves.mjs", APP));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

// One earphone's shape on the grid: a bass dip and a 3 kHz peak, 0 dB at 1 kHz.
const shape = C.GRID.map(f => 4 * Math.exp(-(((Math.log10(f) - 3.5) / 0.3) ** 2)) -
                              3 * Math.exp(-(((Math.log10(f) - 1.7) / 0.4) ** 2)));
const s1k = C.valueAt(C.GRID, shape, 1000);
const curve = (offset, diag) => ({ mags: shape.map(v => v - s1k + offset), diag: { warnings: [], ...diag } });
const relative = curve(0, { normalizedAt: 1000, unit: "dB rel" });
const v4 = curve(110, { normalizedAt: 0, unit: "dB SPL/V" });       // as the V4 panel sends it
const spl = curve(94, { unit: "dB SPL" });                            // an absolute calibration
const raw = curve(-40, { unit: "dB rel" });                           // a raw Rev 3 sweep

test("the grid is analysis.js's: 300 log-spaced points, 20 Hz to 20 kHz", () => {
  assert.equal(C.GRID.length, 300);
  near(C.GRID[0], 20, 1e-9);
  near(C.GRID[299], 20000, 1e-6);
  near(C.GRID[170] / C.GRID[169], C.GRID[1] / C.GRID[0], 1e-12, "even in log frequency");
});

test("valueAt interpolates linearly, and a gap stays a gap without spreading", () => {
  assert.equal(C.valueAt([100, 200], [0, 10], 150), 5);
  assert.equal(C.valueAt([100, 200], [0, 10], 50), 0);
  assert.equal(C.valueAt([100, 200], [0, 10], 500), 10);
  assert.ok(Number.isNaN(C.valueAt([100, 200, 300], [0, NaN, 10], 150)), "between a gap and a value");
  assert.equal(C.valueAt([100, 200, 300], [NaN, 5, 10], 200), 5, "a point beside a gap keeps its value");
  const onIt = C.onGrid(C.GRID, C.GRID.map((f, i) => (i === 7 ? NaN : i)));
  assert.ok(Number.isNaN(onIt[7]) && onIt[8] === 8 && onIt[6] === 6, "on its own grid a curve is itself");
});

test("RMS average: the mean power, REW's way, and a band any curve lacks stays a gap", () => {
  const a = C.GRID.map(() => 0), b = C.GRID.map(() => 10);
  near(C.rmsAverage([a, b])[0], 10 * Math.log10((1 + 10) / 2), 1e-12, "the mean of the powers, not of the dB");
  b[5] = NaN;
  const g = C.rmsAverage([a, b]);
  assert.ok(Number.isNaN(g[5]) && Number.isFinite(g[4]), "a gap stays a gap");
  assert.deepEqual(C.rmsAverage([a]), a, "one curve is itself");
});

test("kinds: relative when normalised, else the unit; absolute only for SPL", () => {
  assert.equal(C.kindOf(relative.diag), "relative");
  assert.equal(C.kindOf(v4.diag), "dB SPL/V");
  assert.equal(C.kindOf(raw.diag), "dB rel");
  assert.ok(C.isAbsolute(v4.diag) && C.isAbsolute(spl.diag));
  assert.ok(!C.isAbsolute(relative.diag) && !C.isAbsolute(raw.diag));
});

test("Normalize off: two curves of one kind keep their levels; across kinds they meet at 1 kHz", () => {
  const at1k = (c, p) => C.valueAt(C.GRID, c.mags, 1000) + p.shift;
  const right = curve(108, v4.diag);
  let p = C.placement([v4, right], 0);
  near(at1k(right, p[1]), 108, 1e-9, "two V4 curves: the 2 dB between the drivers is kept");
  assert.equal(p[1].note, "");
  p = C.placement([v4, relative], 0);
  near(at1k(relative, p[1]), 110, 1e-9, "a relative curve under a V4's");
  assert.equal(p[1].note, " (matched at 1 kHz)");
  p = C.placement([relative, v4], 0);
  near(at1k(v4, p[1]), 0, 1e-9, "a V4's under a relative curve");
  assert.deepEqual(C.placement([relative, curve(0, relative.diag)], 0)[1], { shift: 0, note: "" }, "two relative curves");
  assert.deepEqual(C.placement([v4], 0)[0], { shift: 0, note: "" }, "the first curve sets the scale");
});

test("Normalize on: every curve meets the first at that frequency", () => {
  const right = curve(108, v4.diag);
  const p = C.placement([v4, right, relative], 500);
  for (const [k, c] of [[1, right], [2, relative]])
    near(C.valueAt(C.GRID, c.mags, 500) + p[k].shift, C.valueAt(C.GRID, v4.mags, 500), 1e-9, `curve ${k}`);
});

test("the target meets the first curve at the normalize frequency, 1 kHz when off", () => {
  const flat = C.GRID.map(() => 0);
  near(C.targetShift(v4.mags, flat, 0), 110, 1e-9, "a V4's 110 dB SPL/V at 1 kHz");
  near(C.targetShift(spl.mags, flat, 0), 94, 1e-9, "the Rev 3's 94 dB SPL");
  near(C.targetShift(relative.mags, flat, 0), 0, 1e-9, "0 dB for a relative curve");
  near(C.targetShift(v4.mags, flat, 2000), C.valueAt(C.GRID, v4.mags, 2000), 1e-9, "at 2 kHz when normalised there");
});

test("L/R figures: a gap is left out, and no band in common gives no figure", () => {
  const L = v4.mags.map((v, i) => (i < 6 ? NaN : v));
  const R = curve(108.5, v4.diag).mags.map((v, i) => (i < 6 ? NaN : v));
  const d = C.lrDifference(L, R);
  near(d.max, 1.5, 1e-9);
  near(d.mean, 1.5, 1e-9);
  assert.equal(d.bands, C.GRID.filter(f => f <= 10000).length - 6, "up to 10 kHz, the gaps left out");
  assert.equal(C.lrDifference(L, R.map(() => NaN)), null, "no band in common: no figure");
});

test("the axis top: the highest point with a dB above it, rounded up to 5 dB", () => {
  assert.equal(C.axisTop([[1, 2, 9.5]]), 15);
  assert.equal(C.axisTop([[1, 2, 8]]), 10);
  assert.equal(C.axisTop([[NaN]]), 10, "nothing shown: the fallback");
  assert.equal(C.axisTop([[112.2]]), 115);
});
