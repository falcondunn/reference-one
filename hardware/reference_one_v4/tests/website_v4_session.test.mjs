// The measurement app's V4 tab logic (website/app/js/v4/v4-session.mjs), on the digital twin.
// V4_APP_DIR names the app's folder; tests/test_website_app.py sets it and runs this.
// Every "sweep" here is the twin: nothing touches audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const APP = pathToFileURL(process.env.V4_APP_DIR.replace(/[\\/]*$/, "/"));
const v4 = await import(new URL("js/v4/v4core.mjs", APP));
const { V4Session, V4_LEVEL_DB } = await import(new URL("js/v4/v4-session.mjs", APP));

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const pow2 = n => { let p = 1; while (p < n) p <<= 1; return p; };
const median = (f, v, f0, f1) => { const m = [];
  for (let b = 0; b < f.length; b++) if (f[b] >= f0 && f[b] <= f1 && Number.isFinite(v[b])) m.push(v[b]);
  return m.sort((a, b) => a - b)[m.length >> 1]; };

/** A V4 on the bench, as the twin: MODE, RANGE, what is in the jack, an earphone's flat
 *  sensitivity (dB SPL/V) in Measure mode, the host's volume, and capture faults. `stale` is a
 *  browser running the app's engine from before the V4 wiring, from its cache. */
function twin({ mode = "impedance", high = false, load = 32, sens = 110, volume = 1, mono = false,
                altered = false, playedDb = null, thd2 = 0, stale = false } = {}) {
  let seed = 1;
  return async ({ side, seconds, levelDb, tone }) => {
    const played = playedDb ?? levelDb, n = Math.round(seconds * v4.FS), fade = Math.round(0.01 * v4.FS);
    const base = tone ? Float64Array.from({ length: n }, (_, i) =>     // the engine's tone, 10 ms fades
                          Math.sin(2 * Math.PI * tone * i / v4.FS) * Math.min(1, i / fade, (n - 1 - i) / fade))
                      : v4.logSweep(20, 20000, seconds);
    const stim = Float32Array.from(base, s => 10 ** (played / 20) * s);
    const drive = Array.from(stim, s => volume * s), latency = 2400;
    const pad = pow2(stim.length + Math.round(1.3 * v4.FS));
    const z = load === null ? () => [1e12, 0] : () => [load, 0];
    const c = v4.simulateCapture(drive, z, { high, noise: v4.TWIN_NOISE.typical, seed: seed++, pad, latency });
    let ch1 = c.ch1;
    if (mode === "measure") {                       // the mic hears the tip, 2.7 samples later
      const re = new Float64Array(pad), im = new Float64Array(pad);
      re.set(drive);
      v4.fft(re, im);
      const g = -(high ? v4.HW.gainHigh : v4.HW.gainNormal) * v4.HW.adcDivider * v4.HW.preampGain *
                10 ** (-38 / 20) * 20e-6 * 10 ** (sens / 20);
      for (let k = 0; k < pad; k++) {
        const kk = k <= pad / 2 ? k : k - pad, ph = -2 * Math.PI * kk * (latency + 2.7) / pad;
        const cr = g * Math.cos(ph), ci = g * Math.sin(ph), r = re[k] * cr - im[k] * ci;
        im[k] = re[k] * ci + im[k] * cr; re[k] = r;
      }
      v4.fft(re, im, true);
      if (thd2) {                                   // the earphone's 2nd harmonic: y = x + a x^2
        const a = 2 * thd2 / (Math.abs(g) * 10 ** (played / 20) * volume);
        for (let i = 0; i < pad; i++) re[i] += a * re[i] * re[i];
      }
      let s2 = 977;
      const gauss = () => { s2 = (s2 * 16807) % 2147483647; const u = s2 / 2147483647;
        s2 = (s2 * 16807) % 2147483647; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * s2 / 2147483647); };
      const sd = Math.SQRT1_2 * 10 ** (v4.TWIN_NOISE.typical.ch1 / 20);
      ch1 = re.map(v => Math.round((v + sd * gauss()) * 32768) / 32768);
    }
    if (altered) ch1 = ch1.map(v => 0.9 * v);
    // That engine returns { recording, reference } alone, which the panel passes on like this.
    if (stale) return { stim, ch1, ch2: ch1, levelDb: undefined, channels: 1 };
    return { stim, ch1, ch2: mono ? ch1 : c.ch2, levelDb: played, channels: mono ? 1 : 2 };
  };
}

const checked = async opts => { const s = new V4Session(twin(opts)); assert.ok((await s.check()).ok); return s; };

test("the tab plays the V4's cap, -20 dBFS (spec R12)", () => assert.equal(V4_LEVEL_DB, -20));

test("Check passes a V4 in Impedance mode and NORMAL, earphone in or jack empty", async () => {
  for (const load of [32, null]) {
    const s = new V4Session(twin({ load })), r = await s.check();
    assert.ok(r.ok && s.checked, `${load}: ${r.message}`);
  }
});

test("Check refuses what is not a V4 ready to sweep, saying what to do", async () => {
  const cases = [
    [{ mode: "measure" }, /slide MODE to IMP/],
    [{ high: true }, /Slide RANGE to NORMAL/],
    [{ volume: 10 ** (-3 / 20) }, /volume to 100 %/],
    [{ mono: true }, /2 channel/],
    [{ altered: true }, /changed the recorded samples/],
    [{ playedDb: -14 }, /over the V4's cap/],
    [{ stale: true }, /audio engine is out of date.*Ctrl\+Shift\+R/],
    [{ stale: true, playedDb: -14 }, /played at -14\.0 dBFS, over the V4's cap/],
  ];
  for (const [opts, re] of cases) {
    const s = new V4Session(twin(opts)), r = await s.check();
    assert.ok(!r.ok && !s.checked && re.test(r.message), `${JSON.stringify(opts)}: ${r.message}`);
  }
});

test("Impedance needs Check, then reads the earphone with the unit's K", async () => {
  const fresh = new V4Session(twin());
  assert.match((await fresh.impedance("L")).message, /Check/);
  const s = await checked({});
  const r = await s.impedance("L");
  assert.ok(r.ok, r.message);
  near(median(r.curve.f, r.curve.mag, 200, 10000), 32, 32 * 0.003, "32 ohm");
  assert.match(r.message, /shared ground: about \+0\.2 to \+0\.6 % /, "spec R13: stated with each result");
  const file = { format: v4.CAL.format, version: v4.CAL.version, serial: "T1", date: "2026-10-02",
                 k: { L: 1.01, R: 1.0 }, skew: { L: 0.334e-6, R: 0.334e-6 },
                 nominal: { L: { normal: v4.db(v4.PREFLIGHT.normal), high: v4.db(v4.PREFLIGHT.high) },
                            R: { normal: v4.db(v4.PREFLIGHT.normal), high: v4.db(v4.PREFLIGHT.high) } } };
  s.loadCalibration(file);
  assert.match((await s.impedance("L")).message, /Check/, "a new file asks for Check again");
  assert.ok((await s.check()).ok);
  const k = await s.impedance("L");
  near(median(k.curve.f, k.curve.mag, 200, 10000) / 32, 1.01, 0.004, "the file's K applied");
});

test("Response needs this side's impedance, MODE at MEAS, and the same current", async () => {
  const s = await checked({});
  assert.match((await s.response("L")).message, /impedance first/);
  assert.ok((await s.impedance("L")).ok);
  assert.match((await s.response("L")).message, /slide MODE to MEAS/, "still in Impedance mode");
  s.sweep = twin({ mode: "measure", high: true });
  assert.match((await s.response("L")).message, /current/, "RANGE moved to HIGH since the impedance");
  s.sweep = twin({ mode: "measure" });
  const r = await s.response("L");
  assert.ok(r.ok, r.message);
  near(median(r.curve.f, r.curve.dbSplPerV, 200, 8000), 110, 0.2, "a flat 110 dB SPL/V earphone");
});

test("Calibrate K reads the unit with the jack empty, and refuses a plug in it", async () => {
  const s = await checked({ load: null });
  const r = await s.calibrateK();
  assert.ok(r.ok, r.message);
  near(r.k.L, 1, 0.003, "K L"); near(r.k.R, 1, 0.003, "K R");
  assert.equal(s.options("L").k, r.k.L);
  s.sweep = twin({ load: 32 });
  assert.match((await s.calibrateK()).message, /jack/);
});

test("a unit's file by its serial: the bench's own file name, and the serial must match", async () => {
  const { calibrationFileName } = await import(new URL("js/v4/v4-session.mjs", APP));
  assert.equal(calibrationFileName("V4 0001"), "v4-calibration-V4_0001.json", "the bench page's name for it");
  assert.equal(calibrationFileName("  A/../b  "), "v4-calibration-A_.._b.json", "no path in a serial");
  const file = { format: v4.CAL.format, version: v4.CAL.version, serial: "V4-0001", date: "2026-10-02",
                 k: { L: 1, R: 1 }, skew: { L: 0.334e-6, R: 0.334e-6 },
                 nominal: { L: { normal: v4.db(v4.PREFLIGHT.normal), high: v4.db(v4.PREFLIGHT.high) },
                            R: { normal: v4.db(v4.PREFLIGHT.normal), high: v4.db(v4.PREFLIGHT.high) } } };
  const s = new V4Session(twin());
  assert.throws(() => s.loadCalibration(file, { serial: "V4-0002" }), /for unit V4-0001, not V4-0002/);
  assert.equal(s.cal, null, "nothing loaded from the wrong unit's file");
  assert.equal(s.loadCalibration(file, { serial: " v4-0001 " }).serial, "V4-0001");
});

test("a calibration file from the bench's rehearsal is refused", () => {
  const s = new V4Session(twin());
  assert.throws(() => s.loadCalibration({ format: v4.CAL.format, version: 1, simulated: true }), /digital twin/);
});

test("the impedance as CSV: each side measured, on the app's grid, its units in the header", async () => {
  const { impedanceCsv } = await import(new URL("js/v4/v4-session.mjs", APP));
  const s = await checked({});
  assert.equal(impedanceCsv(s.z), null, "nothing measured, nothing to write");
  assert.ok((await s.impedance("L")).ok);
  let rows = impedanceCsv(s.z).trimEnd().split("\n");
  assert.equal(rows[0], "Frequency (Hz),|Z| L (ohm),Phase L (deg)");
  // Below ~250 Hz an FFT bin (5.9 Hz) is wider than a band of the grid: a band there holds a bin
  // of its own or has no row. On the plot it would take its neighbour's.
  assert.ok(rows.length > 150 && rows.length < 300, `${rows.length} rows`);
  s.sweep = twin({ load: 300 });
  const rr = await s.impedance("R");
  assert.ok(rr.ok, rr.message);
  assert.match(rr.message, /about \+0\.2 to \+0\.6 % /, "the bias is g over the OTHER side's |Z| (32 ohm), not its own");
  rows = impedanceCsv(s.z).trimEnd().split("\n");
  assert.equal(rows[0], "Frequency (Hz),|Z| L (ohm),Phase L (deg),|Z| R (ohm),Phase R (deg)");
  const cells = rows.slice(1).map(r => r.split(","));
  assert.ok(cells.every(c => c.length === 5), "every row has every column");
  assert.ok(cells.every((c, i) => i === 0 || c.slice(1).join() !== cells[i - 1].slice(1).join()),
            "no band borrows its neighbour's bin");
  assert.ok(cells.every(c => c.slice(1).every(v => v === "" || Number.isFinite(+v))), "a gap is empty, never NaN");
  const col = k => cells.filter(c => +c[0] >= 200 && +c[0] <= 10000 && c[k] !== "").map(c => +c[k]);
  const mid = xs => xs.sort((a, b) => a - b)[xs.length >> 1];
  near(mid(col(1)), 32, 32 * 0.003, "|Z| L");
  near(mid(col(3)), 300, 300 * 0.003, "|Z| R, in its own column");
  assert.ok([2, 4].every(k => col(k).every(p => Math.abs(p) < 1)), "a resistor's phase");
  // One side incoherent where the other is not: its cells are empty, the row stays.
  const f = Array.from({ length: 2049 }, (_, b) => b * v4.FS / 4096);
  const r = f.map(x => (x > 1000 && x < 2000 ? NaN : 50));
  const gap = impedanceCsv({ L: { f, mag: f.map(() => 32), phaseDeg: f.map(() => 10) }, R: { f, mag: r, phaseDeg: r } })
    .split("\n").filter(row => +row.split(",")[0] > 1100 && +row.split(",")[0] < 1900);
  assert.ok(gap.length > 10 && gap.every(row => /^\d+\.\d\d,32\.0000,10\.00,,$/.test(row)), gap.join("\n"));
});

test("THD in NORMAL: the earphone's distortion at about 1 kHz, on the seating of its response", async () => {
  const s = await checked({});
  assert.match((await s.thd("L")).message, /impedance and response first/);
  assert.ok((await s.impedance("L")).ok);
  s.sweep = twin({ mode: "measure", thd2: 0.01 });
  assert.ok((await s.response("L")).ok);
  const r = await s.thd("L");
  assert.ok(r.ok && !r.thd.belowFloor, r.message);
  near(r.thd.thdPct, 1.0, 0.05, "1 % of 2nd harmonic");
  assert.match(r.message, /^THD \d\.\d+ % at \d+\.\d Hz, about \d+ dB SPL/, r.message);
  near(r.thd.f0, 1000, 25, "the tone, near 1 kHz and off the comb");
  s.sweep = twin({ mode: "measure" });
  const clean = await s.thd("L");
  assert.ok(clean.ok && clean.thd.belowFloor && /below the measurement floor/.test(clean.message), clean.message);
  s.sweep = twin({ mode: "impedance" });
  assert.match((await s.thd("L")).message, /slide MODE to MEAS/, "MODE moved back to IMP");
  s.sweep = twin({ mode: "measure", high: true });
  assert.match((await s.thd("L")).message, /current moved/, "RANGE moved to HIGH");
});
