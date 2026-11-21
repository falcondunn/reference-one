/**
 * RndB Measure - the Reference One V4 tab's logic.
 *
 * No DOM and no audio. It is handed a `sweep` function, which plays one sweep on one channel
 * and returns both capture channels: the panel (v4-panel.mjs) passes the app's AudioEngine, and
 * the tests pass the V4's digital twin, so every check here runs without a sound card.
 *
 * The analysis is the V4 core (v4core.mjs, a byte-for-byte copy of
 * hardware/reference_one_v4/app/v4core.mjs: change it there, then copy it here).
 *
 * ---------------------------------------------------------------------------
 * THE V4 IS NOT A REV 3
 *
 * The Rev 3 deconvolves one microphone channel against the sweep it played. The V4 records two
 * channels on one ADC clock: ch1 is the earphone's voltage (Impedance mode) or the mic (Measure
 * mode), ch2 its current, in both. Every result here is a RATIO of the two, so the host's volume
 * and play/record drift cancel (board spec 8). It needs one channel driven at a time, both
 * channels captured, and the pre-flight before each sweep (spec 12).
 *
 * And it plays at -20 dBFS, never more (spec R12). The audio engine caps it; this file refuses a
 * sweep that came back louder anyway, because a cap that is not checked is not a cap.
 * ---------------------------------------------------------------------------
 */
import * as v4 from "./v4core.mjs?v=2026-10-19.2";

export const V4_LEVEL_DB = -20;        // spec R12: the cap, and the only level the tab plays
export const SWEEP_S = 5;              // impedance and response
export const K_SWEEP_S = 20;           // K's own noise falls with the length: 0.04 % at 20 s
export const CURRENT_HOLD_DB = 1.0;    // ch2 between a side's impedance and response sweeps
export const MIC_DBV_PA = -38;         // IM73A135 datasheet, +-1 dB: until a unit's mic is calibrated

const FIX_GRID = "The OS changed the recorded samples (software volume, an enhancement or resampling). " +
  "In the Sound control panel, open the interface's Properties, for Playback and for Recording: under " +
  "Advanced choose 2 channel, 16 bit, 48000 Hz, and turn off audio enhancements. On macOS, set " +
  "48,000 Hz 2ch-16bit in Audio MIDI Setup.";
const FIX_MONO = "The capture has one channel, or the second copies the first: the OS is recording in " +
  "mono. Set the interface's recording format to 2 channel, 16 bit, 48000 Hz in the Sound control " +
  "panel's Advanced tab (on macOS, in Audio MIDI Setup).";
const FIX_CLIP = "The capture clipped. A MODE switch moves ch1's DC level for 1-2 s: wait 2 s after " +
  "moving MODE, then sweep again.";
const FIX_STALE = "The page's audio engine is out of date: the browser kept an old copy, which does not " +
  "report the level it played. Reload the page with Ctrl+Shift+R, then run Check again.";

const fail = message => ({ ok: false, message });
const median = xs => { const s = Float64Array.from(xs).sort(); return s.length ? s[s.length >> 1] : NaN; };

/** The capture checks every result needs (spec 12.1-12.3), or null. */
function captureProblem(c) {
  // An engine that reports no level is an old one (FIX_STALE, next): its samples alone say
  // whether it played loud.
  const peakDb = v4.db(c.stim.reduce((m, s) => Math.max(m, Math.abs(s)), 0));
  const saidDb = Number.isFinite(c.levelDb) ? c.levelDb : -Infinity;
  if (!(saidDb <= V4_LEVEL_DB + 0.01) || !(peakDb <= V4_LEVEL_DB + 0.05))
    return `The sweep played at ${Math.max(saidDb, peakDb).toFixed(1)} dBFS, over the V4's cap of ` +
           `${V4_LEVEL_DB} dBFS (spec R12). Nothing was measured: the audio engine must cap it.`;
  if (!Number.isFinite(c.levelDb)) return FIX_STALE;
  if (c.channels < 2 || !v4.channelsDistinct(c.ch1, c.ch2).distinct) return FIX_MONO;
  if (Math.min(v4.onGrid16(c.ch1), v4.onGrid16(c.ch2)) < 1) return FIX_GRID;
  if (v4.clipCount(c.ch1) + v4.clipCount(c.ch2) > 0) return FIX_CLIP;
  return null;
}

/** The current channel per unit of drive, dB, 200 Hz-8 kHz: it is the same in either MODE, and
 *  moves with RANGE, the host's volume and the earphone's seating. */
function currentTransfer(c) {
  const lag = Math.round(v4.latency(c.stim, c.ch2));
  return v4.transfer(c.stim, c.ch2.subarray(lag), 4096);
}
function currentLevelDb(h) {
  const out = [];
  for (let b = 0; b < h.f.length; b++)
    if (h.f[b] >= 200 && h.f[b] <= 8000 && h.coh[b] >= 0.9 && h.mag[b] > 0) out.push(v4.db(h.mag[b]));
  return median(out);
}

// ---- a tone, for THD ---------------------------------------------------------------------------
export const THD_TARGET_HZ = 1000;     // thdTone moves it onto a bin, its harmonics off the 1 kHz comb
export const THD_N = 1 << 17;          // the record analysed: 2.73 s, for 3 dB less noise per line
export const THD_TONE_S = 3.5;         // played: the record starts 0.4 s in, past the latency and fade
const TONE_MATCH_DB = 1, TONE_MATCH_DEG = 10;
// The tip's rms volts at -20 dBFS in NORMAL, for the level a THD was read at: G x drive x the DAC's
// full scale, 0.6 VCCCI peak-to-peak at VCCCI's nominal 3.7 V (3.58-3.81 V, board spec 5.3: +-0.3 dB).
const TIP_RMS_V = v4.HW.gainNormal * 10 ** (V4_LEVEL_DB / 20) * 0.6 * 3.7 / (2 * Math.SQRT2);

/** The complex amplitude of x at exactly f (Hann window): no FFT grid, so no scalloping. */
function toneAt(x, f) {
  let re = 0, im = 0, ws = 0;
  for (let i = 0; i < x.length; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / x.length), ph = 2 * Math.PI * f * i / v4.FS;
    re += x[i] * w * Math.cos(ph); im -= x[i] * w * Math.sin(ph); ws += w;
  }
  return [2 * re / ws, 2 * im / ws];
}
const nearestBin = (h, f) => Math.round(f / (h.f[1] - h.f[0]));
/** Is complex a within TONE_MATCH_DB and TONE_MATCH_DEG of b? */
function alike(a, b) {
  const m = b[0] * b[0] + b[1] * b[1], q = [(a[0] * b[0] + a[1] * b[1]) / m, (a[1] * b[0] - a[0] * b[1]) / m];
  return Math.abs(v4.db(Math.hypot(...q))) <= TONE_MATCH_DB && Math.abs(Math.atan2(q[1], q[0])) * 180 / Math.PI <= TONE_MATCH_DEG;
}

/** The name the bench page saves a unit's calibration file under, and the app fetches it by
 *  (spec 12.10: the codec has no USB serial, so the serial printed on the base is the key).
 *  Anything but letters, digits, dot, dash and underscore becomes "_", so a serial is never a path. */
export function calibrationFileName(serial) {
  return `v4-calibration-${String(serial).trim().replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** Each measured side's |Z| and phase on the app's grid, as CSV with the units in the header, or
 *  null with none measured. A file takes each band from its own bins (`bandsOnly`): a band with
 *  none is an empty cell, never a neighbour's value, and a row with no value is left out. Below
 *  ~250 Hz a bin (5.9 Hz) is wider than a band, so most bands there have no row. */
export function impedanceCsv(z) {
  const sides = ["L", "R"].filter(s => z[s]);
  if (!sides.length) return null;
  const cols = sides.flatMap(s => [z[s].mag, z[s].phaseDeg].map(v => onAppGrid(z[s].f, v, { bandsOnly: true })));
  const rows = [["Frequency (Hz)", ...sides.flatMap(s => [`|Z| ${s} (ohm)`, `Phase ${s} (deg)`])].join(",")];
  cols[0].freqs.forEach((f, i) => {
    const v = cols.map(c => c.values[i]);
    if (v.some(Number.isFinite))
      rows.push([f.toFixed(2), ...v.map((x, k) => (Number.isFinite(x) ? x.toFixed(k % 2 ? 2 : 4) : ""))].join(","));
  });
  return rows.join("\n") + "\n";
}

/** A curve on the app's grid: 300 points, log-spaced 20 Hz to 20 kHz (analysis.js), each the mean
 *  of the finite values in its band, or the nearest finite bin where a band holds none. That suits
 *  a plot; `bandsOnly` leaves such a band NaN, which suits a file. */
export function onAppGrid(f, values, { bandsOnly = false, points = 300, fMin = 20, fMax = 20000 } = {}) {
  const ratio = (fMax / fMin) ** (1 / (points - 1)), edge = Math.sqrt(ratio);
  const freqs = new Array(points), out = new Array(points);
  for (let i = 0; i < points; i++) {
    const fc = fMin * ratio ** i;
    let sum = 0, n = 0, best = NaN, gap = Infinity;
    for (let b = 0; b < f.length; b++) {
      if (!Number.isFinite(values[b])) continue;
      if (f[b] >= fc / edge && f[b] <= fc * edge) { sum += values[b]; n++; }
      const d = Math.abs(Math.log(f[b] / fc));
      if (f[b] > 0 && d < gap) { gap = d; best = values[b]; }
    }
    freqs[i] = fc;
    out[i] = n ? sum / n : (!bandsOnly && gap < Math.log(ratio) ? best : NaN);
  }
  return { freqs, values: out };
}

export class V4Session {
  /** sweep({ side: "L" | "R", seconds, levelDb }) resolves to
   *  { stim, ch1, ch2, levelDb, channels }: the samples played on that side, both capture
   *  channels, the level it played, and how many channels the capture carried. */
  constructor(sweep) {
    this.sweep = sweep;
    this.cal = null;                   // calibrationFor's L and R, from the unit's file
    this.serial = null;
    this.checked = false;              // a V4, in NORMAL, since the last change
    this.k = { L: null, R: null };     // an on-demand K, newer than the file's
    this.z = { L: null, R: null };
    this.currentDb = { L: null, R: null };      // ch2 per unit of drive, and its transfer, at impedance
    this.currentH = { L: null, R: null };
    this.h12 = { L: null, R: null };            // ch1/ch2 from the impedance and the response sweeps
    this.responses = { L: null, R: null };
  }

  /** What the core's functions take for one side: the unit's file, or the design's values. */
  options(side) {
    const f = this.cal?.[side];
    return { k: this.k[side] ?? f?.k ?? 1, skew: f?.skew, nominal: f?.nominal ?? null, micDbvPa: MIC_DBV_PA };
  }

  /** The unit's calibration file (bench page, app/README.md). Throws with the reason on a file
   *  the core refuses, or, when `serial` is given, on another unit's file. Its K and read-back
   *  change every result, so Check runs again. */
  loadCalibration(file, { serial } = {}) {
    if (serial !== undefined && String(file?.serial ?? "").trim().toLowerCase() !== String(serial).trim().toLowerCase())
      throw new Error(`This file is for unit ${file?.serial}, not ${String(serial).trim()}.`);
    const cal = { L: v4.calibrationFor(file, "L"), R: v4.calibrationFor(file, "R") };
    this.cal = cal;
    this.serial = String(file.serial ?? "");
    this._reset();
    return { serial: this.serial, k: { L: cal.L.k, R: cal.R.k } };
  }

  _reset() {
    this.checked = false;
    this.k = { L: null, R: null };
    this.z = { L: null, R: null };
    this.currentDb = { L: null, R: null };      // ch2 per unit of drive, and its transfer, at impedance
    this.currentH = { L: null, R: null };
    this.h12 = { L: null, R: null };            // ch1/ch2 from the impedance and the response sweeps
    this.responses = { L: null, R: null };
  }

  /** One sweep in Impedance mode on `side`, through every gate a V4 sweep needs: the capture,
   *  MODE, the V4's signature (spec 12.13) and the pre-flight (spec 7). The capture, or { fail }. */
  async _impedanceSweep(side, seconds) {
    const c = await this.sweep({ side, seconds, levelDb: V4_LEVEL_DB });
    const problem = captureProblem(c);
    if (problem) return { fail: problem };
    const m = v4.detectMode(c.stim, c.ch1, c.ch2), nominal = this.options(side).nominal;
    const id = v4.identify(m.mode, m.levelDb, nominal);
    if (!id.v4) return { fail: id.message };
    const pf = v4.preflight(10 ** (m.levelDb / 20), 1, false, nominal);
    if (!pf.ok) return { fail: pf.message };
    return { c, mode: m, preflight: pf };
  }

  /** MODE at IMP, RANGE at NORMAL, the earphone in the coupler or the jack empty: a left sweep
   *  confirms a V4 ready to measure. */
  async check() {
    this.checked = false;
    const s = await this._impedanceSweep("L", SWEEP_S);
    if (s.fail) return fail(s.fail);
    this.checked = true;
    return { ok: true, message: `A V4, in NORMAL: the tip reads ${s.mode.levelDb.toFixed(2)} dB per unit of ` +
             `drive. ${s.preflight.message}` };
  }

  /** K for a unit without a calibration file: MODE at IMP, the jack EMPTY (spec 8). */
  async calibrateK() {
    if (!this.checked) return fail("Run Check first: it confirms a V4, in NORMAL, before any sweep.");
    const k = {};
    for (const side of ["L", "R"]) {
      const s = await this._impedanceSweep(side, K_SWEEP_S);
      if (s.fail) return fail(s.fail);
      const zc = v4.impedanceCurve(s.c.ch1, s.c.ch2, { k: 1 }), mags = [];
      for (let b = 0; b < zc.f.length; b++) if (zc.f[b] >= 200 && zc.f[b] <= 10000 && Number.isFinite(zc.mag[b])) mags.push(zc.mag[b]);
      if (median(mags) < 5000)
        return fail(`Something is in the jack: ${side} reads ${median(mags).toFixed(1)} ohm. K is read with the ` +
                    "jack EMPTY (board spec 8): unplug it and run again.");
      k[side] = v4.calibrateK(s.c.ch1, s.c.ch2, { skew: this.options(side).skew });
    }
    this.k = k;
    this.z = { L: null, R: null };
    this.currentDb = { L: null, R: null };      // ch2 per unit of drive, and its transfer, at impedance
    this.currentH = { L: null, R: null };
    this.h12 = { L: null, R: null };            // ch1/ch2 from the impedance and the response sweeps
    this.responses = { L: null, R: null };
    return { ok: true, k, message: `K ${k.L.toFixed(4)} left, ${k.R.toFixed(4)} right. It holds for this session; ` +
             "a calibration file from the bench holds it for good." };
  }

  /** MODE at IMP, the earphone's `side` driven: its impedance, NORMAL only (core README). */
  async impedance(side) {
    if (!this.checked) return fail("Run Check first: it confirms a V4, in NORMAL, before any sweep.");
    const s = await this._impedanceSweep(side, SWEEP_S);
    if (s.fail) return fail(s.fail);
    const o = this.options(side), curve = v4.impedanceCurve(s.c.ch1, s.c.ch2, { k: o.k, skew: o.skew });
    this.z[side] = curve;
    this.currentH[side] = currentTransfer(s.c);
    this.currentDb[side] = currentLevelDb(this.currentH[side]);
    this.h12[side] = { imp: v4.transfer(s.c.ch2, s.c.ch1, 8192), meas: null };
    this.responses[side] = null;
    const i1k = Math.round(299 * Math.log(50) / Math.log(1000)), at1k = onAppGrid(curve.f, curve.mag).values[i1k];
    // Spec R13: a one-side reading is high by about g / |Z| of the OTHER side, g the cable's shared ground,
    // and no sweep can tell g. State it with each result, for a typical g. Earpieces match, so until the
    // other side is measured this side's |Z| stands in for it.
    const other = this.z[side === "L" ? "R" : "L"], zo = other && onAppGrid(other.f, other.mag).values[i1k];
    const [lo, hi] = [0.05, 0.2].map(g => (100 * v4.groundBias(at1k, Number.isFinite(zo) ? zo : at1k, g)).toFixed(1));
    return { ok: true, curve, message: `|Z| ${at1k.toFixed(2)} ohm at 1 kHz. Like any one-side reading, it is high by the ` +
             `cable's shared ground: about +${lo} to +${hi} % for 0.05-0.2 ohm. With a detachable cable, unplug the other earpiece.` };
  }

  /** MODE at MEAS, the same earphone, seated as for its impedance: its response in dB SPL per
   *  volt at the tip. The volts come from the current and the impedance (spec 3), so the
   *  host's volume does not enter. */
  async response(side) {
    if (!this.z[side])
      return fail("Measure this side's impedance first, with MODE at IMP: the response is per volt, and the " +
                  "volts come from it.");
    const c = await this.sweep({ side, seconds: SWEEP_S, levelDb: V4_LEVEL_DB });
    const problem = captureProblem(c);
    if (problem) return fail(problem);
    const m = v4.detectMode(c.stim, c.ch1, c.ch2);
    if (m.mode !== "measure")
      return fail(`MODE reads ${m.mode}: slide MODE to MEAS, wait 2 s, and sweep again.`);
    const moved = currentLevelDb(currentTransfer(c)) - this.currentDb[side];
    if (!(Math.abs(moved) <= CURRENT_HOLD_DB))
      return fail(`The current moved ${moved.toFixed(1)} dB since this side's impedance sweep: RANGE, the host's ` +
                  "volume or the earphone's seating changed. Measure the impedance again, then the response.");
    const o = this.options(side);
    const curve = v4.sensitivityCurve(c.ch1, c.ch2, this.z[side], { k: o.k, skew: o.skew, micDbvPa: o.micDbvPa });
    this.responses[side] = curve;
    this.h12[side].meas = v4.transfer(c.ch2, c.ch1, 8192);
    const g = onAppGrid(curve.f, curve.dbSplPerV), at1k = g.values[Math.round(299 * Math.log(50) / Math.log(1000))];
    return { ok: true, curve, message: `${at1k.toFixed(1)} dB SPL/V at 1 kHz` +
             (this.cal ? "." : `, on the mic datasheet's ${MIC_DBV_PA} dBV/Pa (+-1 dB): no calibration file.`) };
  }

  /** MODE at MEAS, in NORMAL, the earphone seated as for its response: THD at a tone near 1 kHz,
   *  at -20 dBFS (spec 12.8). A tone cannot tell MODE the way a sweep does, so it is checked
   *  against this side's two sweeps instead. Its current must hold to 1 dB of the impedance
   *  sweep's: RANGE, the volume. Its ch1/ch2, which drift cannot move (one ADC clock), must
   *  match the response sweep's and not the impedance sweep's: MODE, and the seating. HIGH is
   *  not offered: the app cannot see where the earphone is, and HIGH is 20 dB louder. */
  async thd(side) {
    if (!this.z[side] || !this.responses[side])
      return fail("Take this side's impedance and response first: THD is read in Measure mode, on that seating.");
    const f0 = v4.thdTone(THD_TARGET_HZ, THD_N);
    const c = await this.sweep({ side, seconds: THD_TONE_S, levelDb: V4_LEVEL_DB, tone: f0 });
    const problem = captureProblem(c);
    if (problem) return fail(problem);
    const s0 = Math.round(0.4 * v4.FS);
    if (c.ch1.length < s0 + THD_N) return fail("The capture ended before the tone did.");
    const x1 = c.ch1.subarray(s0, s0 + THD_N), x2 = c.ch2.subarray(s0, s0 + THD_N);
    const i2 = toneAt(x2, f0), hI = this.currentH[side];
    const moved = v4.db(Math.hypot(...i2) / 10 ** (c.levelDb / 20) / hI.mag[nearestBin(hI, f0)]);
    if (!(Math.abs(moved) <= CURRENT_HOLD_DB))
      return fail(`The current moved ${moved.toFixed(1)} dB since this side's impedance sweep: RANGE or the host's ` +
                  "volume changed. THD is read in NORMAL only.");
    const i1 = toneAt(x1, f0), r = [(i1[0] * i2[0] + i1[1] * i2[1]) / (i2[0] ** 2 + i2[1] ** 2),
                                    (i1[1] * i2[0] - i1[0] * i2[1]) / (i2[0] ** 2 + i2[1] ** 2)];
    const ref = h => { const b = nearestBin(h, f0); return [h.re[b], h.im[b]]; };
    const asImp = alike(r, ref(this.h12[side].imp)), asMeas = alike(r, ref(this.h12[side].meas));
    if (asImp && !asMeas) return fail("MODE reads IMP: slide MODE to MEAS, wait 2 s, and run THD again.");
    if (!asMeas)
      return fail("The earphone reads differently at the tone than in its response sweep: the seating or MODE " +
                  "changed. Take the impedance and response again, then THD.");
    if (asImp)
      return fail("At this tone the earphone's voltage and its sound read alike, so MODE cannot be told apart. " +
                  "Check MODE is at MEAS and read THD from the response's harmonics instead.");
    const t = v4.thd(x1, f0, v4.FS, 5);
    const resp = this.responses[side], spl = resp.dbSplPerV[nearestBin(resp, f0)] + v4.db(TIP_RMS_V);
    const where = `at ${t.f0.toFixed(1)} Hz, about ${spl.toFixed(0)} dB SPL`;
    const lines = t.harmonics.filter(h => !h.belowFloor).map(h => `H${h.h} ${h.levelDb.toFixed(1)} dB`).join(", ");
    return { ok: true, thd: t, splDb: spl, message: t.belowFloor
      ? `THD below the measurement floor ${where}: under ${t.thdPct.toFixed(3)} %.`
      : `THD ${t.thdPct.toFixed(3)} % ${where}. ${lines}.` };
  }
}
