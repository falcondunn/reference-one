// node --test hardware/reference_one_v4/app
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v4 from "./v4core.mjs";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

// The ADC dividers, from the schematic, not from HW: every op-amp-fed channel goes through 1 k
// into the codec's 30 k; ch1 in Impedance mode also through the summing node, R20-R22 at 20.0 k
// each (6.67 k). The first real board read K 1.205 where a single shared divider had said 1.
const DIV = 30e3 / 31e3, DIV_IMP = 30e3 / (30e3 + 20e3 / 3 + 1e3);

// ---- capture checks ----------------------------------------------------------------
test("the 16-bit grid catches OS processing", () => {
  const clean = Float32Array.from({ length: 1000 }, (_, i) => Math.round(8000 * Math.sin(i / 7)) / 32768);
  assert.equal(v4.onGrid16(clean), 1);
  const gained = clean.map(s => s * 0.891);          // -1 dB of software volume
  assert.ok(v4.onGrid16(gained) < 0.05);
});

test("full-scale samples count as clips", () => {
  assert.equal(v4.clipCount(Float32Array.from([0, 0.5, 32767 / 32768, -1, 0.99])), 2);
});

test("a copied channel is caught, a correlated one is not", () => {
  const l = Float64Array.from({ length: 4800 }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / 48000));
  const r = l.map((s, i) => 0.3 * Math.sin(2 * Math.PI * 1000 * i / 48000 + 0.4));   // same tone, other gain/phase
  assert.equal(v4.channelsDistinct(l, Float64Array.from(l)).distinct, false);
  assert.equal(v4.channelsDistinct(l, r).distinct, true);
});

// ---- pre-flight --------------------------------------------------------------------
test("pre-flight nominal gains are the design's", () => {
  // the tip read-back is ch1 in Impedance mode: through the summing node's 6.67 k as well as
  // the 1 k, 1.69 dB under the 1 k path alone (the first board read 1.66 dB under the old value)
  near(v4.db(v4.PREFLIGHT.normal), -29.059, 0.001);
  near(v4.db(v4.PREFLIGHT.high), -9.087, 0.001);
});

test("Impedance mode's ch1 divider is the summing node's, not the 1 k paths'", () => {
  near(v4.HW.adcDividerImp, DIV_IMP, 1e-12);
  near(v4.HW.adcDivider, DIV, 1e-12, "ch2, and ch1 in Measure mode");
});

test("pre-flight passes NORMAL, warns on a low volume, refuses a fault or an unexpected HIGH", () => {
  const drive = 0.1;
  const at = dbOver => drive * v4.PREFLIGHT.normal * 10 ** (dbOver / 20);
  assert.deepEqual([v4.preflight(at(0), drive).range, v4.preflight(at(0), drive).ok], ["NORMAL", true]);
  const low = v4.preflight(at(-6), drive);
  assert.equal(low.ok, true);
  assert.match(low.message, /volume is 6\.0 dB down/);
  const fault = v4.preflight(at(1.5), drive);            // e.g. a shorted gain resistor
  assert.deepEqual([fault.range, fault.ok], ["FAULT", false]);
  const high = v4.preflight(drive * v4.PREFLIGHT.high, drive);
  assert.deepEqual([high.range, high.ok], ["HIGH", false]);
  assert.equal(v4.preflight(drive * v4.PREFLIGHT.high, drive, true).ok, true);
});

test("HIGH, even when asked for, is refused more than 1 dB above its own nominal (spec 7)", () => {
  // 12 single faults put HIGH +1.1 to +3.0 dB hot into 8 ohm (design_checks' fault set,
  // one channel driven); a +-3 dB window around HIGH accepted every one of them
  const drive = 0.05, at = dbOver => drive * v4.PREFLIGHT.high * 10 ** (dbOver / 20);
  const hot = v4.preflight(at(1.5), drive, true);
  assert.deepEqual([hot.range, hot.ok], ["FAULT", false], JSON.stringify(hot));
  assert.match(hot.message, /HIGH is 1\.5 dB above its nominal/);
  assert.deepEqual([v4.preflight(at(0.5), drive, true).range, v4.preflight(at(0.5), drive, true).ok], ["HIGH", true]);
  assert.equal(v4.preflight(at(1.5), drive, false).ok, false);
});

test("a unit's own factory nominal absorbs the codec's gain errors (PCM2900C: +-10 % each, max)", () => {
  // DAC and ADC both at +10 %: a healthy unit reads +1.66 dB, which the design nominal calls
  // a fault; held to its own nominal (spec 13.3 item 1's read-back) it passes, and a real
  // +1.5 dB fault on top of it is still refused
  const drive = 0.05, codec = 1.1 * 1.1, dbOf = x => 20 * Math.log10(x);
  const own = { normal: dbOf(v4.PREFLIGHT.normal * codec), high: dbOf(v4.PREFLIGHT.high * codec) };
  const healthy = drive * v4.PREFLIGHT.normal * codec;
  assert.equal(v4.preflight(healthy, drive).range, "FAULT");
  const withOwn = v4.preflight(healthy, drive, false, own);
  assert.ok(withOwn.ok && withOwn.range === "NORMAL" && Math.abs(withOwn.overNormalDb) < 1e-9, JSON.stringify(withOwn));
  assert.equal(v4.preflight(healthy * 10 ** (1.5 / 20), drive, false, own).range, "FAULT");
  const high = v4.preflight(drive * v4.PREFLIGHT.high * codec, drive, true, own);
  assert.ok(high.ok && high.range === "HIGH", JSON.stringify(high));
});

test("identify: the tip channel's level is the V4's signature, within the codec's spread (spec 12.13)", () => {
  const n = v4.db(v4.PREFLIGHT.normal), h = v4.db(v4.PREFLIGHT.high);
  const unit = v4.logSweep(20, 20000, 2.0);
  for (const high of [false, true]) {                 // the twin, in either range
    const cap = v4.simulateCapture(unit, () => [32, 0], { high }), m = v4.detectMode(unit, cap.ch1, cap.ch2);
    const id = v4.identify(m.mode, m.levelDb);
    assert.ok(id.v4 && id.range === (high ? "HIGH" : "NORMAL"), JSON.stringify(id));
  }
  // the codec's gain errors put a healthy unit -1.83 to +1.66 dB off (R14): still a V4
  for (const off of [-1.83, 1.66]) assert.equal(v4.identify("impedance", n + off).v4, true, `${off} dB`);
  // lower is the host's volume, or another device: only 100 % tells which
  const low = v4.identify("impedance", n - 3);
  assert.ok(!low.v4 && /volume to 100 %/.test(low.message) && /not a V4/.test(low.message), low.message);
  // HIGH with the volume down is told so, not that it is a fault
  const highLow = v4.identify("impedance", h - 3);
  assert.ok(!highLow.v4 && /under a V4's HIGH/.test(highLow.message) && /volume to 100 %/.test(highLow.message), highLow.message);
  // over NORMAL, nearer it than HIGH: a fault, or not a V4
  assert.match(v4.identify("impedance", n + 3).message, /over a V4's NORMAL.*Do not measure/);
  // a loopback through another PCM2900C interface reads near unity: far over either range
  const loop = v4.identify("impedance", -0.5);
  assert.ok(!loop.v4 && /over a V4's HIGH.*Do not measure/.test(loop.message), loop.message);
  assert.equal(v4.identify("impedance", h + 2.5).v4, false);
  // only Impedance mode carries the signature
  for (const mode of ["measure", "unknown"]) assert.equal(v4.identify(mode, n).v4, false, mode);
  assert.equal(v4.identify("impedance", NaN).v4, false);
  // with its calibration file, a unit is held to its own read-back, by the pre-flight's 1 dB
  const own = { normal: n - 1.5, high: h - 1.5 };
  assert.equal(v4.identify("impedance", n - 1.5, own).v4, true);
  assert.equal(v4.identify("impedance", n - 2.8, own).v4, false, "1.3 dB under its own: the volume");
  assert.equal(v4.identify("impedance", h - 1.4, own).range, "HIGH");
});

test("the worst single fault in NORMAL (+5.8 dB, spec 7) is refused", () => {
  const drive = 0.05, r = v4.preflight(drive * v4.PREFLIGHT.normal * 10 ** (5.8 / 20), drive);
  assert.equal(r.ok, false);
});

// ---- impedance ---------------------------------------------------------------------
function channelsFor(z, k = v4.HW.senseK.normal) {
  // the board's two channels for a load z (ohm, complex) across R_ref, 1 V at the tip above
  // the sleeve, the other side idle (spec 8's formula case). The idle ring over-follows the
  // sleeve by k, so it sits at (1 + k) V_s and its own R_ref draws k V_s / R_ref through R_s.
  const rs = v4.HW.rSense, yRef = 1 / v4.HW.rRef;
  const zz = Array.isArray(z) ? z : [z, 0];
  const m = zz[0] ** 2 + zz[1] ** 2;
  const ya = [zz[0] / m + yRef, -zz[1] / m];              // the load and R_ref, per volt
  const d = 1 - k * rs * yRef;                            // V_s = R_s (ya + k V_s / R_ref)
  const vs = [rs * ya[0] / d, rs * ya[1] / d];
  // (V_tip + V_ring)/3 and G R_s I, as the ADC records them: each through its own divider
  const v1 = [DIV_IMP * (1 + (2 + k) * vs[0]) / 3, DIV_IMP * ((2 + k) * vs[1]) / 3];
  const v2 = [DIV * vs[0] * v4.HW.currentGain, DIV * vs[1] * v4.HW.currentGain];
  return [v1, v2];
}

test("Z from the channels, R_ref removed, reads the load to 10 ppm", () => {
  // exact but for the idle ring's R_ref current: (k R_s / R_ref)(1 + |Z| / R_ref), 4.4 ppm at
  // 8 ohm and 5.7 at 300, far under R_ref's own 0.1 %
  for (const z of [8, 32, 300, [12, 9], [40, -5]]) {
    const [v1, v2] = channelsFor(z);
    const got = v4.removeRef(v4.zFromChannels(v1, v2));
    const want = Array.isArray(z) ? z : [z, 0];
    near(got[0], want[0], 1e-5 * Math.hypot(...want));
    near(got[1], want[1], 1e-5 * Math.hypot(...want));
  }
});

test("the formula takes NORMAL's k: 2 R_s alone reads 4.4 mohm high", () => {
  const [v1, v2] = channelsFor(8), toCircuit = DIV / DIV_IMP;      // the ADC's ratio back to the circuit's
  const bare = 3 * v4.HW.currentGain * v4.HW.rSense * toCircuit * (v1[0] * v2[0] + v1[1] * v2[1]) / (v2[0] ** 2 + v2[1] ** 2) - 2 * v4.HW.rSense;
  near(bare - v4.zFromChannels(v1, v2)[0], v4.HW.senseK.normal * v4.HW.rSense, 1e-12, "the k R_s term");
});

test("a channel gain error K scales the reading and K corrects it", () => {
  const [v1, v2] = channelsFor(32);
  const skewed = [v1[0] * 1.02, v1[1] * 1.02];            // ch1 reads 2 % high
  const raw = v4.removeRef(v4.zFromChannels(skewed, v2));
  assert.ok(raw[0] > 32.5);
  near(v4.removeRef(v4.zFromChannels(skewed, v2, 1 / 1.02))[0], 32, 32 * 5e-6);
});

test("a shorted-plug reading comes off in series", () => {
  assert.deepEqual(v4.subtractContact([16.05, 0.2], [0.05, 0]), [16.0, 0.2]);
});

test("the ground bias is g/Z_other for matched sides, 0.6 % at 8 ohm with 0.05 ohm", () => {
  near(v4.groundBias(8, 8, 0.05), 0.05 / 8.05, 1e-12);
  assert.ok(v4.groundBias(300, 300, 0.2) < 0.0007);
});

// ---- spectra and MODE ------------------------------------------------------------------
function filterFreq(x, response, delay = 0, pad = 1 << 17) {
  // x through a frequency response response(f) -> [re, im], then a (fractional) delay, in samples
  const n = pad, re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  v4.fft(re, im);
  for (let k = 0; k < n; k++) {
    const kk = k <= n / 2 ? k : k - n, f = kk * v4.FS / n;
    const [hr, hi] = response(Math.abs(f));
    const hiS = kk < 0 ? -hi : hi;                    // Hermitian
    const ph = -2 * Math.PI * kk / n * delay, dr = Math.cos(ph), di = Math.sin(ph);
    const gr = hr * dr - hiS * di, gi = hr * di + hiS * dr;
    const a = re[k], b = im[k];
    re[k] = a * gr - b * gi; im[k] = a * gi + b * gr;
  }
  v4.fft(re, im, true);
  return re;
}

const noise = (n, level, seed = 1) => {
  let s = seed;
  return Float64Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; return level * (s / 2147483647 - 0.5); });
};
const add = (a, b) => a.map((v, i) => v + b[i]);

// an inductive BA-like impedance and a resonant earphone response
const zOf = f => { const w = 2 * Math.PI * f; return [12 + 4 * (f / 20000), w * 60e-6]; };
const currentOf = f => { const [r, x] = zOf(f); const m = r * r + x * x; return [r / m, -x / m]; };   // I = V/Z
const iemOf = f => { const q = 3, f0 = 3000, u = f / f0; const re = 1 - u * u, im = u / q; const m = re * re + im * im;
                     return [0.05 * re / m, -0.05 * im / m]; };      // a 2nd-order resonance, not flat
const flatIemOf = () => [0.05, 0];

test("the sweep, latency and transfer tools recover a known system", () => {
  const stim = v4.logSweep(20, 20000, 1.0);
  const resp = filterFreq(stim, () => [0.5, 0], 1234.3);
  // a parabola through a broadband correlation peak is biased by up to ~0.1 sample; only
  // the integer part aligns the frames, and the phase slope below measures the rest
  near(v4.latency(stim, resp), 1234.3, 0.1, "latency");
  const aligned = resp.subarray(1234);
  const h = v4.transfer(stim, aligned);
  const k = Math.round(1000 / (v4.FS / 4096));
  near(h.mag[k], 0.5, 0.005, "gain at 1 kHz");
  near(v4.delaySamples(h, 500, 8000), 0.3, 0.05, "residual delay");
});

test("the delay fit skips bins under the coherence gate, even for unwrapping", () => {
  // strong spurs (5x the signal) break coherence at five bins; unwrapped through them, the
  // phase took a false 2 pi and the delay read 17.7 samples instead of 0
  const stim = v4.logSweep(20, 20000, 2.0).map(v => 0.05 * v);
  const cap = v4.simulateCapture(stim, () => [16, 0], { latency: 0 });
  const ch1 = cap.ch1.map((v, i) => v + 0.01 * [1000, 2000, 3000, 5000, 7000].reduce(
    (s, f) => s + Math.sin(2 * Math.PI * f * i / v4.FS + f), 0));
  near(v4.delaySamples(v4.transfer(cap.ch2, ch1), 500, 8000), 0, 0.05, "delay");
});

test("latency finds an inverted path: the board's output stage inverts (spec 7)", () => {
  const stim = v4.logSweep(20, 20000, 1.0);
  near(v4.latency(stim, filterFreq(stim, () => [-0.5, 0], 1234.3)), 1234.3, 0.1, "latency");
});

// a strongly inductive BA: 10 ohm and 0.6 mH, so the current lags by L/R = 60 us (2.9 samples)
const inductiveCurrentOf = f => { const r = 10, x = 2 * Math.PI * f * 0.6e-3, m = r * r + x * x; return [r / m, -x / m]; };

function capture(mode, flat = false, current = currentOf, acoustic = 3.4) {
  const stim = v4.logSweep(20, 20000, 2.0), lat = 7321;
  const ch2 = add(filterFreq(stim, f => { const [r, i] = current(f); return [r * 0.5, i * 0.5]; }, lat), noise(1 << 17, 1e-5, 3));
  const ch1 = mode === "impedance"            // a flat G v / 3 plus the sleeve's share, (2 + 2k) V_s / 3
    ? add(add(filterFreq(stim, () => [0.0428, 0], lat), ch2.map(v => v * (2 + 2 * v4.HW.senseK.normal) / (3 * v4.HW.currentGain))),
          noise(1 << 17, 1e-5, 5))
    : add(filterFreq(stim, flat ? flatIemOf : iemOf, lat + acoustic), noise(1 << 17, 1e-5, 7));
  return [stim, ch1, ch2];
}

test("MODE: Impedance is flat and in step with the current channel", () => {
  const r = v4.detectMode(...capture("impedance"));
  assert.equal(r.mode, "impedance", JSON.stringify(r));
  near(r.latency, 7321, 1);
});

test("MODE: Measure lags the current channel through the acoustic path", () => {
  const r = v4.detectMode(...capture("measure"));
  assert.equal(r.mode, "measure", JSON.stringify(r));
});

test("MODE: a flat earphone is still told apart by its acoustic delay", () => {
  const r = v4.detectMode(...capture("measure", true));
  assert.ok(r.flatnessDb < 1.0, `flat: ${r.flatnessDb}`);
  assert.equal(r.mode, "measure", JSON.stringify(r));
});

test("MODE: an inductive driver in Impedance mode is still Impedance", () => {
  const r = v4.detectMode(...capture("impedance", false, inductiveCurrentOf));
  assert.ok(r.delaySamples < -0.5, `ch1 leads the lagging current: ${r.delaySamples}`);
  assert.equal(r.mode, "impedance", JSON.stringify(r));
});

test("MODE: a flat, inductive earphone in Measure mode is caught by passivity, not delay", () => {
  // the 2.7 sample acoustic path, less the current's lag, leaves the delay within half a
  // sample of its 1.5 limit; passivity decides by a factor of ten
  const r = v4.detectMode(...capture("measure", true, inductiveCurrentOf, 2.7));
  assert.ok(r.delaySamples < 2.0 && r.flatnessDb < 1.0, JSON.stringify(r));
  assert.ok(r.nonPassive > 0.3, `not passive: ${r.nonPassive}`);
  assert.equal(r.mode, "measure", JSON.stringify(r));
});

test("MODE holds when the drive path inverts both channels, as the board's does", () => {
  const neg = x => x.map(v => -v);
  for (const mode of ["impedance", "measure"]) {
    const [stim, ch1, ch2] = capture(mode);
    const r = v4.detectMode(stim, neg(ch1), neg(ch2));
    assert.equal(r.mode, mode, JSON.stringify(r));
    near(r.latency, 7321, 1);
  }
});

// ---- THD ---------------------------------------------------------------------------------
test("THD tones sit on a bin and keep every harmonic off the 1 kHz comb", () => {
  for (const target of [100, 300, 1000, 3000, 6000]) {
    const f = v4.thdTone(target, 65536);
    const df = v4.FS / 65536;
    near(f / df, Math.round(f / df), 1e-9, `bin-centred ${f}`);
    assert.ok(Math.abs(f - target) < 60, `near ${target}: ${f}`);
    for (let h = 1; h <= 5 && h * f < v4.FS / 2; h++)
      assert.ok(Math.abs(h * f - 1000 * Math.round(h * f / 1000)) >= 20, `harmonic ${h} of ${f}`);
  }
  assert.ok(Math.abs(997 - 1000) < 20, "997 Hz would sit inside the comb guard");
});

function tone(f, amps, n, ppm = 0, noiseLevel = 0) {
  const nz = noise(n, noiseLevel, 9);
  return Float64Array.from({ length: n }, (_, i) => {
    const t = i / v4.FS * (1 + ppm * 1e-6);
    return amps.reduce((s, a, h) => s + a * Math.sin(2 * Math.PI * (h + 1) * f * t + 0.3 * h), 0) + nz[i];
  });
}

test("THD reads known harmonics, with play/record drift moving the tone", () => {
  const n = 65536, f = v4.thdTone(1000, n);
  const r = v4.thd(tone(f, [0.5, 0.5e-3, 0.25e-3], n, 80, 1e-6), f);
  near(r.thdPct, 100 * Math.hypot(0.5e-3, 0.25e-3) / 0.5, 0.002, "THD %");
  assert.equal(r.belowFloor, false);
  near(r.f0, f * (1 + 80e-6), 0.01, "drifted fundamental");
  near(r.harmonics[0].levelDb, v4.db(1e-3), 0.05, "H2");
});

test("THD at or under the chain's own (spec 7: the floor measured in 13.1) is below the measurement floor", () => {
  // harmonics well clear of the noise are still the codec's and the mic's if they are no more
  // than the chain makes on its own; the app must not report them as the earphone's
  const n = 65536, f = v4.thdTone(1000, n), x = tone(f, [0.5, 0.25e-3, 0.1e-3], n, 0, 1e-6);   // 0.054 %
  const plain = v4.thd(x, f);
  assert.equal(plain.belowFloor, false);
  assert.equal(plain.belowChainFloor, false, "no chain floor given, none applied");
  const under = v4.thd(x, f, v4.FS, 5, { chainFloorPct: 0.1 });
  assert.ok(under.belowChainFloor && under.chainFloorPct === 0.1, JSON.stringify(under.belowChainFloor));
  assert.equal(v4.thd(x, f, v4.FS, 5, { chainFloorPct: 0.02 }).belowChainFloor, false);
});

test("harmonics under the noise are reported below the floor, with a bound", () => {
  const n = 65536, f = v4.thdTone(1000, n);
  const r = v4.thd(tone(f, [0.5, 1e-7, 1e-7], n, 0, 1e-3), f);
  assert.equal(r.belowFloor, true);
  assert.ok(r.harmonics.every(h => h.belowFloor));
  assert.ok(r.thdPct > 0 && r.thdPct < 0.05, `bound ${r.thdPct} %`);
});

// ---- the curves ----------------------------------------------------------------------------
// The board, per frequency, for a drive U(f) at the tip above the sleeve: the earphone z
// and R_ref in parallel, the sleeve through R_s, ch1 through the 1 k into 30 k divider.
function boardCapture(mode, drive, z, spl = null, micDbvPa = -38, acousticDelay = 2.7, k = v4.HW.senseK.normal,
                      fp = v4.HW.currentPoleHz) {
  // drive is the output's source voltage G v (volts, per sample). The tip follows the sleeve
  // by (1 + k), so U = G v + k V_s, and the idle ring sits at (1 + k) V_s over its R_ref:
  // V_s = R_s (ya U + k V_s / R_ref), ya the load and R_ref. The current amp rolls off at fp.
  // A separate solve from the twin's.
  const hw = v4.HW, div = DIV, divImp = DIV_IMP, rs = hw.rSense, yRef = 1 / hw.rRef;
  const perGv = f => {                                     // [U, V_s] per volt of G v
    const [zr, zi] = z(f), m = zr * zr + zi * zi, ya = [zr / m + yRef, -zi / m];
    const dr = 1 - k * rs * (ya[0] + yRef), di = -k * rs * ya[1], dm = dr * dr + di * di;
    const vs = [rs * (ya[0] * dr + ya[1] * di) / dm, rs * (ya[1] * dr - ya[0] * di) / dm];
    return [[1 + k * vs[0], k * vs[1]], vs];
  };
  const ch2 = filterFreq(drive, f => { const [, vs] = perGv(f), s = hw.currentGain * div / (1 + (f / fp) ** 2);
    return [(vs[0] + vs[1] * f / fp) * s, (vs[1] - vs[0] * f / fp) * s]; });          // / (1 + j f / fp)
  let ch1;
  if (mode === "impedance") {
    ch1 = filterFreq(drive, f => { const [u, vs] = perGv(f);
      return [divImp * (u[0] + (2 + k) * vs[0]) / 3, divImp * (u[1] + (2 + k) * vs[1]) / 3]; });
  } else {
    const g = div * hw.preampGain * 10 ** (micDbvPa / 20) * 20e-6;          // ADC units per (Pa re 20 uPa)
    ch1 = filterFreq(drive, f => { const [a, b] = spl(f), [u] = perGv(f);   // the earphone plays U
      return [(a * u[0] - b * u[1]) * g, (a * u[1] + b * u[0]) * g]; }, acousticDelay);
  }
  return [add(ch1, noise(1 << 17, 1e-7, 21)), add(ch2, noise(1 << 17, 1e-7, 23))];
}

const baZ = f => { const w = 2 * Math.PI * f; return [9 + 3 * f / 10000, w * 0.4e-3]; };   // 9 ohm, 0.4 mH
const flat110 = () => [10 ** (110 / 20), 0];     // 110 dB SPL per volt, as a pressure ratio

test("the impedance curve reads a BA earphone across the band", () => {
  const drive = v4.logSweep(20, 20000, 2.0).map(s => 0.05 * s);
  const zc = v4.impedanceCurve(...boardCapture("impedance", drive, baZ));
  for (const f of [100, 1000, 5000, 10000]) {
    const b = Math.round(f / (v4.FS / 8192));
    const want = Math.hypot(...baZ(zc.f[b]));
    near(zc.mag[b], want, 0.001 * want, `|Z| at ${f} Hz`);
  }
});

test("sensitivity in dB SPL/V ignores the host's volume and the drive level", () => {
  const sweep = v4.logSweep(20, 20000, 2.0);
  const zc = v4.impedanceCurve(...boardCapture("impedance", sweep.map(s => 0.05 * s), baZ));
  for (const level of [0.05, 0.025]) {                   // the host turns the volume down 6 dB
    const drive = sweep.map(s => level * s);
    const sc = v4.sensitivityCurve(...boardCapture("measure", drive, baZ, flat110), zc);
    for (const f of [200, 1000, 4000, 10000]) {
      const b = Math.round(f / (v4.FS / 8192));
      near(sc.dbSplPerV[b], 110, 0.02, `${level} at ${f} Hz`);
    }
  }
});

test("sensitivity takes K, so the ADC's channel mismatch (up to 5 %) stays out of it", () => {
  // the PCM2900C's channels may differ by 5 % (SBFS039); K, from the empty jack, holds that
  // ratio together with R_s and the current amp's gain, and dB SPL/V is a ch1/ch2 ratio too
  const sweep = v4.logSweep(20, 20000, 2.0).map(s => 0.05 * s), hot = x => x.map(v => v * 1.03);
  const [e1, e2] = boardCapture("impedance", sweep, () => [1e12, 0]);
  const k = v4.calibrateK(hot(e1), e2);
  const [z1, z2] = boardCapture("impedance", sweep, baZ);
  const zc = v4.impedanceCurve(hot(z1), z2, { k });
  const [m1, m2] = boardCapture("measure", sweep, baZ, flat110);
  const b = Math.round(1000 / (v4.FS / 8192));
  near(v4.sensitivityCurve(hot(m1), m2, zc).dbSplPerV[b], 110 + 20 * Math.log10(1.03), 0.02, "without K: the mismatch");
  near(v4.sensitivityCurve(hot(m1), m2, zc, { k }).dbSplPerV[b], 110, 0.02, "with K");
});

test("a mic calibration offset moves the sensitivity one for one", () => {
  const sweep = v4.logSweep(20, 20000, 2.0).map(s => 0.05 * s);
  const zc = v4.impedanceCurve(...boardCapture("impedance", sweep, baZ));
  const hot = v4.sensitivityCurve(...boardCapture("measure", sweep, baZ, flat110, -37), zc, { micDbvPa: -38 });
  const b = Math.round(1000 / (v4.FS / 8192));
  near(hot.dbSplPerV[b], 111, 0.02, "a mic 1 dB hot, read with the datasheet value");
});

test("the current amp's pole reads as impedance phase; the typical or the unit's own skew removes it", () => {
  // the TLV9064's closed-loop pole (GBP / 21, 476 kHz typ) lags ch2 by 0.33 us: 2.6 degrees
  // at 20 kHz on a pure 32 ohm. The GBP spreads, so each unit's own skew comes from a
  // reference plug (a resistor, phase 0); the jack-empty capture is too faint for it
  const s = v4.logSweep(20, 20000, 2.0).map(v => 0.1 * v), b20 = Math.round(20000 / (v4.FS / 8192));
  const typ = v4.simulateCapture(s, () => [32, 0]);
  near(v4.impedanceCurve(typ.ch1, typ.ch2, { skew: 0 }).phaseDeg[b20], 2.6, 0.1, "uncorrected");
  near(v4.impedanceCurve(typ.ch1, typ.ch2).phaseDeg[b20], 0, 0.02, "the typical skew, by default");
  const slow = v4.simulateCapture(s, () => [32, 0], { currentPoleHz: 0.7 * v4.HW.currentPoleHz });   // GBP 30 % low
  assert.ok(Math.abs(v4.impedanceCurve(slow.ch1, slow.ch2).phaseDeg[b20]) > 0.5, "the typical skew leaves a slow part's");
  const skew = v4.calibrateSkew(slow.ch1, slow.ch2);
  near(skew, 1 / (2 * Math.PI * 0.7 * v4.HW.currentPoleHz), 0.005e-6, "the unit's skew");
  const zc = v4.impedanceCurve(slow.ch1, slow.ch2, { skew });
  near(zc.phaseDeg[b20], 0, 0.02, "the unit's own skew");
  near(zc.mag[b20], 32, 32 * 2e-4, "|Z| at 20 kHz");
});

test("K from the empty jack undoes a channel gain mismatch", () => {
  const drive = v4.logSweep(20, 20000, 2.0).map(s => 0.05 * s);
  const open = () => [1e12, 0];                                  // nothing plugged in
  const [e1, e2] = boardCapture("impedance", drive, open);
  near(v4.calibrateK(e1, e2), 1, 3e-5, "a matched unit: the pole's roll-off is not counted twice (6e-5)");
  const k = v4.calibrateK(e1.map(s => s * 1.02), e2);             // ch1 2 % hot
  near(k, 1 / 1.02, 1e-4, "K");
  const [c1, c2] = boardCapture("impedance", drive, baZ);
  const zc = v4.impedanceCurve(c1.map(s => s * 1.02), c2, { k });
  const b = Math.round(1000 / (v4.FS / 8192));
  near(zc.mag[b], Math.hypot(...baZ(zc.f[b])), 0.001 * Math.hypot(...baZ(zc.f[b])), "calibrated |Z|");
});

test("K and the impedance hold with the codec's own noise on both channels", () => {
  // an H1 estimate takes its reference's noise as a bias, |H1| = |H| / (1 + N/S). With the jack
  // empty, ch2 sits near -72 dBFS at -20 dBFS, 13-20 dB over the codec's noise per bin: K on
  // ch2 read 2.5 % high, and a 300 ohm load 0.9 % low. ch1 holds near -48 dBFS for any load.
  const drive = v4.logSweep(20, 20000, 5).map(s => 0.1 * s);          // the bench's sweep
  const median = zc => { const m = [];
    for (let b = 0; b < zc.f.length; b++) if (zc.f[b] >= 200 && zc.f[b] <= 10000 && Number.isFinite(zc.mag[b])) m.push(zc.mag[b]);
    return m.sort((a, b) => a - b)[m.length >> 1]; };
  // one capture's K scatters by the noise itself: 0.10 % (1 sigma) typical, 0.17 % worst
  const tol = { typical: { mean: 0.0015, each: 0.003, z: 0.002 }, worst: { mean: 0.002, each: 0.005, z: 0.003 } };
  for (const [name, noise] of Object.entries(v4.TWIN_NOISE)) {
    const ks = [1, 2, 3, 4, 5, 6].map(seed => {
      const e = v4.simulateCapture(drive, () => [1e12, 0], { noise, seed });
      assert.equal(v4.onGrid16(e.ch2), 1, "the twin records on the 16-bit grid");
      return v4.calibrateK(e.ch1, e.ch2);
    });
    near(ks.reduce((a, b) => a + b) / ks.length, 1, tol[name].mean, `${name} noise: K, the mean of six captures`);
    for (const k of ks) near(k, 1, tol[name].each, `${name} noise: K, each capture`);
    for (const r of [32, 300]) {
      const c = v4.simulateCapture(drive, () => [r, 0], { noise, seed: 7 });
      near(median(v4.impedanceCurve(c.ch1, c.ch2)), r, r * tol[name].z, `${name} noise: ${r} ohm`);
    }
  }
});

test("K assumes no delay between the ADC channels: ch2 a whole sample late reads the same", () => {
  // the codec's datasheet states none; inside one 94 Hz block a sample turns the phase 0.012 rad.
  // A phase-sensitive K (a fitted delay, or the real part) would read this capture low
  const drive = v4.logSweep(20, 20000, 5).map(s => 0.1 * s);
  const c = v4.simulateCapture(drive, () => [1e12, 0]), late = new Float64Array(c.ch2.length);
  late.set(c.ch2.subarray(0, c.ch2.length - 1), 1);
  near(v4.calibrateK(c.ch1, late), v4.calibrateK(c.ch1, c.ch2), 1e-4, "K, ch2 one sample late");
});

test("K ignores the USB frames' 1 kHz comb, which sits in both channels at once", () => {
  // a line 20 dB over the idle step's limit (about -110 dBFS) moved K 0.09 %: coherent between
  // the channels, it adds to the cross-spectrum in every frame
  const drive = v4.logSweep(20, 20000, 5).map(s => 0.1 * s);
  const c = v4.simulateCapture(drive, () => [1e12, 0], { noise: v4.TWIN_NOISE.typical });
  const comb = (x, ph) => x.map((v, i) => { let s = v;
    for (let m = 1; m <= 20; m++) s += 10 ** (-90 / 20) * Math.sin(2 * Math.PI * 1000 * m * i / v4.FS + ph * m);
    return s; });
  near(v4.calibrateK(comb(c.ch1, 0.3), comb(c.ch2, 1.1)), v4.calibrateK(c.ch1, c.ch2), 2e-4, "K with the comb");
});

test("MODE and the pre-flight read the tip voltage: every load passes, 8 ohm to open", () => {
  // ch1 = (U + 2 R_s I)/3 reads 1 + 2 R_s/Z above the tip: +1.9 dB into 8 ohm, which the
  // pre-flight took for a hardware fault, and a BA's swing made Impedance mode look uneven
  const unit = v4.logSweep(20, 20000, 2.0);
  const loads = { open: () => [1e12, 0], "300": () => [300, 0], "32": () => [32, 0], "16": () => [16, 0],
                  "8": () => [8, 0], BA: baZ };
  for (const [name, z] of Object.entries(loads)) {
    const cap = v4.simulateCapture(unit, z);
    const m = v4.detectMode(unit, cap.ch1, cap.ch2);
    const pf = v4.preflight(10 ** (m.levelDb / 20), 1);
    assert.equal(m.mode, "impedance", `${name}: ${JSON.stringify(m)}`);
    assert.ok(pf.ok && Math.abs(pf.overNormalDb) < 0.05, `${name}: ${JSON.stringify(pf)}`);
  }
});

test("a healthy HIGH unit reads HIGH's nominal into any load, so its 1 dB rule passes it", () => {
  // HIGH's sense bridge is unbalanced (k = 0.64, spec 7): read with NORMAL's k, a healthy unit
  // into 8 ohm sat +1.4 dB over HIGH's nominal, and the pre-flight called it a fault
  const unit = v4.logSweep(20, 20000, 2.0);
  for (const r of [8, 16, 32, 300, 1e12]) {
    const cap = v4.simulateCapture(unit, () => [r, 0], { high: true });
    const m = v4.detectMode(unit, cap.ch1, cap.ch2);
    const pf = v4.preflight(10 ** (m.levelDb / 20), 1, true);
    assert.equal(m.mode, "impedance", `${r} ohm: ${JSON.stringify(m)}`);
    assert.ok(pf.range === "HIGH" && pf.ok, `${r} ohm: ${JSON.stringify(pf)}`);
    near(m.levelDb, v4.db(v4.PREFLIGHT.high), 0.05, `${r} ohm level`);
  }
});

test("the pre-flight still refuses a real over-gain into a low impedance", () => {
  const unit = v4.logSweep(20, 20000, 2.0), cap = v4.simulateCapture(unit, () => [8, 0]);
  const hot = x => x.map(v => v * 1.2);                    // +1.6 dB at the tip: both channels follow
  const m = v4.detectMode(unit, hot(cap.ch1), hot(cap.ch2));
  const pf = v4.preflight(10 ** (m.levelDb / 20), 1);
  assert.equal(pf.range, "FAULT", JSON.stringify(pf));
  near(pf.overNormalDb, 20 * Math.log10(1.2), 0.05, "over nominal");
});

// ---- the calibration file (app/README.md) -------------------------------------------------
const calFile = () => ({
  format: v4.CAL.format, version: v4.CAL.version, serial: "V4-0001", date: "2026-10-01T00:00:00.000Z",
  k: { L: 1.012, R: 0.991 }, skew: { L: 0.34e-6, R: 0.31e-6 },
  nominal: { L: { normal: v4.db(v4.PREFLIGHT.normal) + 1.5, high: v4.db(v4.PREFLIGHT.high) + 1.5 },
             R: { normal: v4.db(v4.PREFLIGHT.normal) - 1.2, high: v4.db(v4.PREFLIGHT.high) - 1.2 } },
});

test("a calibration file gives each channel the options the core takes", () => {
  // L reads 1.5 dB hot, inside the codec's +1.66 dB (spec R14): the design's nominal refuses
  // it, and its own read-back passes it
  const f = calFile(), L = v4.calibrationFor(JSON.parse(JSON.stringify(f)), "L"), R = v4.calibrationFor(f, "R");
  assert.deepEqual(L, { k: 1.012, skew: 0.34e-6, nominal: f.nominal.L });
  assert.deepEqual(R, { k: 0.991, skew: 0.31e-6, nominal: f.nominal.R });
  const reading = 10 ** (f.nominal.L.normal / 20);
  assert.equal(v4.preflight(reading, 1).range, "FAULT");
  assert.ok(v4.preflight(reading, 1, false, L.nominal).ok);
});

test("a calibration file with any value no healthy unit gives is refused whole, naming the value", () => {
  const refused = (edit, re) => { const f = calFile(); edit(f); assert.throws(() => v4.calibrationFor(f, "R"), re); };
  refused(f => { f.format = "reference-one-v3-calibration"; }, /Not a V4 calibration file/);
  refused(f => { f.version = 2; }, /Not a V4 calibration file/);
  refused(f => { f.k.L = 1.2; }, /channel L: K 1\.2 is outside/);         // L's value refuses R as well
  refused(f => { f.k.L = "1.0"; }, /K is "1\.0", not a number/);
  refused(f => { delete f.skew.L; }, /skew is undefined, not a number/);
  refused(f => { f.skew.L = 2e-6; }, /skew 2\.000 us is outside 0\.1 to 1 us/);
  // the host's volume left down through steps 2 and 3: both ranges lower than the codec's
  // errors explain, with the step between them held
  refused(f => { f.nominal.R.normal -= 1.0; f.nominal.R.high -= 1.0; }, /NORMAL reads 2\.20 dB under the design's/);
  refused(f => { f.nominal.L.normal += 0.7; f.nominal.L.high += 0.7; }, /NORMAL reads 2\.20 dB over the design's/);
  // the volume moved between the two read-backs: resistors set the step, so it shows
  refused(f => { f.nominal.L.high += 0.5; }, /HIGH sits 20\.47 dB over NORMAL, not 19\.97/);
  refused(f => { delete f.nominal.L.high; }, /No HIGH read-back/);
  assert.throws(() => v4.calibrationFor(calFile(), "left"), /channel "left"/);
  refused(f => { f.simulated = true; }, /digital twin/);      // a bench rehearsal is never a unit's file
});

test("impedance is NORMAL's alone: in HIGH the formula reads 0.6 ohm high and more (spec 7)", () => {
  // HIGH's sense bridge is unbalanced (k = 0.64), and the formula's (2 + k) R_s is NORMAL's; HIGH is
  // for level and THD only. A HIGH sweep must not become an impedance curve
  const s = v4.logSweep(20, 20000, 2).map(v => 0.01 * v);
  const median = zc => { const m = [];
    for (let b = 0; b < zc.f.length; b++) if (zc.f[b] >= 200 && zc.f[b] <= 10000 && Number.isFinite(zc.mag[b])) m.push(zc.mag[b]);
    return m.sort((a, b) => a - b)[m.length >> 1]; };
  // (k_HIGH - k_NORMAL) R_s = 0.64 ohm, and more as the load rises: 0.66 at 32 ohm, 0.83 at 300
  for (const r of [8, 32, 300]) {
    const h = v4.simulateCapture(s, () => [r, 0], { high: true }), err = median(v4.impedanceCurve(h.ch1, h.ch2)) - r;
    assert.ok(err > 0.6 && err < 0.9, `${r} ohm in HIGH reads ${err.toFixed(3)} ohm high`);
  }
});

test("the digital twin agrees with the tests' own board model", () => {
  const drive = v4.logSweep(20, 20000, 2.0).map(s => 0.1 * s);
  const twin = v4.simulateCapture(drive, baZ, { latency: 0, pad: 1 << 17 });
  // test model: the source voltage G v at the tip, which the output stage inverts (spec 7)
  const [ch1, ch2] = boardCapture("impedance", drive.map(s => -s * v4.HW.gainNormal), baZ);
  let worst = 0;
  for (let i = 1000; i < 90000; i += 7) worst = Math.max(worst, Math.abs(twin.ch1[i] - ch1[i]), Math.abs(twin.ch2[i] - ch2[i]));
  assert.ok(worst < 1e-6, `largest difference ${worst}`);
  const zc = v4.impedanceCurve(twin.ch1, twin.ch2);
  const b = Math.round(1000 / (v4.FS / 8192));
  // the Welch estimate of a sweep carries ~0.05 % of bias; the spec budget is 0.3 %
  near(zc.mag[b], Math.hypot(...baZ(zc.f[b])), 1e-3 * Math.hypot(...baZ(zc.f[b])), "twin reads back");
});
