// The studio's EQ (website/app/js/studio/peq.mjs): the cookbook biquads, their sum and preamp,
// the APO, GraphicEQ, CSV and JSON files, and AutoEQ. Nothing here plays.
// V4_APP_DIR names the app's folder; test_website_app.py runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const APP = pathToFileURL(process.env.V4_APP_DIR.replace(/[\\/]*$/, "/"));
const C = await import(new URL("js/studio/curves.mjs", APP));
const Q = await import(new URL("js/studio/peq.mjs", APP));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const at = (filter, f) => Q.filterResponse(filter, [f])[0];

test("biquads: the cookbook's values at the filter's own frequency, and flat far from it", () => {
  near(at({ type: "PK", f: 1000, gain: 6, q: 1 }, 1000), 6, 1e-9, "a peak reaches its gain at Fc");
  near(at({ type: "PK", f: 1000, gain: -6, q: 1 }, 20), 0, 0.05, "and is flat two decades away");
  near(at({ type: "LSC", f: 1000, gain: 6, q: 0.7 }, 20), 6, 0.05, "a low shelf: its gain below");
  near(at({ type: "LSC", f: 1000, gain: 6, q: 0.7 }, 1000), 3, 1e-9, "half its gain at Fc");
  near(at({ type: "LSC", f: 1000, gain: 6, q: 0.7 }, 20000), 0, 0.1, "nothing above");
  near(at({ type: "HSC", f: 1000, gain: -4, q: 0.7 }, 20000), -4, 0.1, "a high shelf: its gain above");
  near(at({ type: "LPQ", f: 2000, gain: 0, q: 2 }, 2000), 20 * Math.log10(2), 1e-9, "a pass filter is Q at Fc");
  near(at({ type: "HPQ", f: 200, gain: 0, q: Math.SQRT1_2 }, 200), 20 * Math.log10(Math.SQRT1_2), 1e-9);
  near(at({ type: "HPQ", f: 200, gain: 0, q: Math.SQRT1_2 }, 20), -40, 0.3, "12 dB an octave: -40 dB a decade down");
  assert.throws(() => Q.coefficients({ type: "XYZ", f: 1000, gain: 0, q: 1 }), /Unknown filter type/);
});

test("the EQ sums its filters, skips one switched off, and the preamp stops the largest boost", () => {
  const fs = [100, 1000, 5000];
  const a = { type: "PK", f: 1000, gain: 4, q: 1, on: true }, b = { type: "PK", f: 5000, gain: -3, q: 2, on: true };
  Q.eqResponse([a, b], fs).forEach((v, i) => near(v, at(a, fs[i]) + at(b, fs[i]), 1e-12));
  assert.deepEqual(Q.eqResponse([a, { ...b, on: false }], fs), Q.filterResponse(a, fs));
  assert.equal(Q.preamp([a, b]), -4, "-4 dB for a 4 dB peak");
  assert.equal(Q.preamp([{ ...a, gain: 4.04 }]), -4.1, "rounded up to 0.1 dB");
  assert.equal(Q.preamp([b]), 0, "no boost, no preamp");
  assert.equal(Q.preamp([]), 0);
});

test("APO text: written the way AutoEq writes it, and read back", () => {
  const filters = [{ type: "PK", f: 105.4, gain: 2.5, q: 0.7, on: true }, { type: "HSC", f: 10000, gain: -3, q: 0.71, on: true },
                   { type: "HPQ", f: 20, gain: 0, q: 0.71, on: false }];
  const text = Q.toApo(filters);
  assert.equal(text, "Preamp: -2.5 dB\nFilter 1: ON PK Fc 105 Hz Gain 2.5 dB Q 0.70\n" +
                     "Filter 2: ON HSC Fc 10000 Hz Gain -3.0 dB Q 0.71\nFilter 3: OFF HPQ Fc 20 Hz Q 0.71\n");
  const back = Q.fromApo(text);
  assert.equal(back.preampDb, -2.5);
  assert.deepEqual(back.filters.map(x => [x.type, x.f, x.gain, x.q, x.on]),
                   [["PK", 105, 2.5, 0.7, true], ["HSC", 10000, -3, 0.71, true], ["HPQ", 20, 0, 0.71, false]]);
  assert.match(Q.toApo(filters.slice(0, 1), { channel: "R" }), /^Channel: R\nPreamp: /);
  assert.deepEqual(Q.fromApo("Filter: ON PEQ Fc 1000 Hz Gain -2 dB Q 1.4\n").filters[0], { type: "PK", f: 1000, gain: -2, q: 1.4, on: true });
  assert.throws(() => Q.fromApo("Preamp: -3 dB\n"), /No "Filter" lines/);
  assert.throws(() => Q.fromApo("Filter 1: ON XYZ Fc 100 Hz\n"), /not a filter this app reads/);
});

test("GraphicEQ: Wavelet's line on AutoEq's 127 frequencies, its top 0.2 dB under zero", () => {
  assert.equal(Q.GRAPHIC_EQ_FREQS.length, 127);
  assert.deepEqual([Q.GRAPHIC_EQ_FREQS[0], Q.GRAPHIC_EQ_FREQS[1], Q.GRAPHIC_EQ_FREQS.at(-1)], [20, 21, 19871]);
  const line = Q.toGraphicEq([{ type: "PK", f: 1000, gain: 6, q: 1, on: true }]);
  assert.match(line, /^GraphicEQ: 20 -\d+\.\d; 21 /);
  const vals = line.slice("GraphicEQ: ".length).trim().split("; ").map(p => Number(p.split(" ")[1]));
  assert.equal(vals.length, 127);
  near(Math.max(...vals), -0.2, 0.051);
});

test("CSV and JSON round-trip, and a bad line is named", () => {
  const filters = [{ type: "PK", f: 1000, gain: -3, q: 1.41, on: true }, { type: "LSC", f: 105, gain: 4, q: 0.71, on: false }];
  assert.deepEqual(Q.fromCsv(Q.toCsv(filters)), filters);
  const j = Q.fromJson(Q.toJson(filters, -4.1));
  assert.deepEqual(j.filters, filters);
  assert.equal(j.preampDb, -4.1);
  assert.throws(() => Q.fromCsv("type,frequency,gain,q,on\nPK,abc,1,1,1\n"), /line 2/);
  assert.throws(() => Q.fromJson("[]"), /no filters/);
});

// AutoEQ: a target, and the target with two peaking filters added. AutoEQ must find their inverse.
const target = C.GRID.map(f => 6 * Math.exp(-(((Math.log10(f) - 1.6) / 0.5) ** 2)) + 8 * Math.exp(-(((Math.log10(f) - 3.45) / 0.25) ** 2)));
const bumped = (g3k, offset = 0) => target.map((t, i) => t + offset + at({ type: "PK", f: 3000, gain: g3k, q: 2 }, C.GRID[i]) +
                                                           at({ type: "PK", f: 200, gain: -4, q: 1 }, C.GRID[i]));

test("AutoEQ finds what was added to the target, inside its limits", () => {
  const r = Q.autoEq(bumped(6), target, { count: 6 });
  assert.ok(r.rmsBefore > 1.5, `before ${r.rmsBefore}`);
  assert.ok(r.rmsAfter < 0.5, `after ${r.rmsAfter}`);
  for (const x of r.filters)
    assert.ok(x.type === "PK" && x.gain <= 6 && x.gain >= -12 && x.q >= 0.5 && x.q <= 5 && x.f >= 20 && x.f <= 10000, JSON.stringify(x));
  assert.deepEqual(r.filters.map(x => x.f), r.filters.map(x => x.f).sort((a, b) => a - b), "sorted by frequency");
  near(Q.fitError(bumped(6), target, r.filters, 20, 10000), r.rmsAfter, 1e-9, "the error of the rounded filters it returns");
});

test("AutoEQ keeps its limits when the error is larger than they allow", () => {
  const deep = target.map((t, i) => (C.GRID[i] > 4000 && C.GRID[i] < 6000 ? t - 20 : t));
  const r = Q.autoEq(deep, target, { count: 3, maxBoost: 3 });
  assert.ok(r.filters.length > 0 && r.filters.every(x => x.gain <= 3), JSON.stringify(r.filters));
});

test("AutoEQ works on the difference alone: 110 dB SPL/V gives the filters 0 dB does", () => {
  const m = bumped(6);
  assert.deepEqual(Q.autoEq(m.map(v => v + 110), target.map(v => v + 110), { count: 4 }).filters, Q.autoEq(m, target, { count: 4 }).filters);
});

test("AutoEQ refuses a fit with nothing to fit", () => {
  assert.throws(() => Q.autoEq(target.map(() => NaN), target), /Too few bands/);
});

test("channel match: one side EQ'd to the other's shape, and their level difference said", () => {
  const L = bumped(6), R = bumped(3, 0.8);
  const r = Q.channelMatch(L, R, { count: 4 });
  near(r.levelDb, C.valueAt(C.GRID, R, 1000) - C.valueAt(C.GRID, L, 1000), 1e-9, "R minus L at 1 kHz");
  assert.ok(r.rmsBefore > 0.4 && r.rmsAfter < 0.3, `${r.rmsBefore} -> ${r.rmsAfter}`);
  assert.ok(r.filters.every(x => Math.abs(x.gain) <= 6), "±6 dB");
});
