// Reference One V4 - the measurement app's core: spec section 12 as pure functions.
//
// No DOM and no audio APIs: node --test runs everything here (v4core.test.mjs), and
// the board's pytest suite runs that (tests/test_app_core.py), checking HW against
// design_checks.py so the two cannot drift apart.
//
// Channels: ch1 is ADC left (the mic in Measure, (V_tip + V_ring)/3 in Impedance),
// ch2 is ADC right (the earphone current, x20 across 1.00 ohm, in both modes). Both
// sit on one ADC clock, so their ratio carries no play/record drift (spec 8, 12).

export const FS = 48000;

// From the placed values (design_checks.py; tests/test_app_core.py compares them).
export const HW = Object.freeze({
  gainNormal: 0.132736,        // |DAC -> jack|, NORMAL
  gainHigh: 1.323212,          // |DAC -> jack|, HIGH
  adcDivider: 30e3 / 31e3,     // 1.0 k into the codec's 30 k: ch2, and ch1 in Measure mode
  // ch1 in Impedance mode: MODE takes it from the summing node (R20-R22, 20.0 k each: 6.67 k)
  // through the same 1 k. The first board read this (K 1.205, the tip 1.66 dB low, 2026-10-19).
  adcDividerImp: 30e3 / (30e3 + 20e3 / 3 + 1e3),
  currentGain: 20,             // the current amp
  rSense: 1.0,                 // R_s, ohm
  rRef: 1000,                  // R_ref, tip-sleeve and ring-sleeve, ohm
  preampGain: 1.11277,         // the mic preamp, 52.3 k / 47.0 k, differential in
  // how far each output over-follows the sleeve: V_out = G V_dac + (1 + k) V_sleeve, the
  // idle one included (design_checks.sense_k). HIGH's bridge is unbalanced (spec 7).
  senseK: Object.freeze({ normal: 0.004378687516, high: 0.642133789557 }),
  // the current amp's closed-loop pole: TLV9064 GBP 10 MHz typ over its noise gain, 1 + 20
  // (design_checks.current_pole_hz). It lags ch2 by 1/(2 pi f_p), 0.33 us.
  currentPoleHz: 10e6 / 21,
});

// How much more ch1 loses than ch2 in Impedance mode: every ch1/ch2 ratio taken there is this
// much under the circuit's, and K (calibrateK) is left to hold only the channels' mismatch,
// which Measure mode shares. Folded into K instead, it put dB SPL/V 1.7 dB high.
const IMP_LOSS = HW.adcDividerImp / HW.adcDivider;

// Impedance mode: the tip channel (tipChannel: ch1 less the sleeve's share, on the range's
// own k) per unit of DAC drive, which is G v / 3: the output's source voltage, the same for
// every load. In NORMAL it is the tip voltage U / 3 to 4 mohm; in HIGH, U rises with load. The ADC and DAC full scales are both
// 0.6 x VCCCI, so this does not depend on VCCCI.
export const PREFLIGHT = Object.freeze({
  normal: HW.gainNormal / 3 * HW.adcDividerImp,   // -29.06 dB
  high: HW.gainHigh / 3 * HW.adcDividerImp,       // -9.09 dB
  overTolDb: 1.0,              // spec 7: refuse more than 1 dB above nominal
  highWindowDb: 3.0,           // HIGH is recognised this close to its nominal
});

export const db = x => 20 * Math.log10(x);

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

// ---- capture checks (spec 12.1-12.3) ------------------------------------------
/** Fraction of samples on the 16-bit grid. Anything under 1 means the OS changed the
 *  data: software gain, an "enhancement" or resampling (spec 12.2). */
export function onGrid16(x) {
  let off = 0;
  for (let i = 0; i < x.length; i++) {
    const q = x[i] * 32768;
    if (Math.abs(q - Math.round(q)) > 1e-3) off++;
  }
  return x.length ? 1 - off / x.length : NaN;
}

/** Samples at full scale: each one clips the sweep it is in (spec 12.3). */
export function clipCount(x) {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= 32767 / 32768) n++;
  return n;
}

/** ch2 must not be a copy of ch1: Windows can default the endpoint to mono (spec
 *  12.1). The two channels are correlated in normal use (both follow the stimulus),
 *  so this tests for a copy, not for independence. */
export function channelsDistinct(l, r) {
  const n = Math.min(l.length, r.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += (l[i] - r[i]) ** 2;
  const scale = Math.max(rms(l), rms(r));
  const ratio = scale > 0 ? Math.sqrt(d / n) / scale : 0;
  return { distinct: ratio > 1e-3, ratio };
}

// ---- pre-flight (spec 7) ---------------------------------------------------------
/** The tip channel: the drive's own share of ch1, sample by sample, in ch1's units, which
 *  is G v / 3, the output's source voltage, the same for every load. In Impedance mode
 *  ch1 = (V_tip + V_ring)/3, with V_tip = G v + (1 + k) V_s and the idle V_ring = (1 + k) V_s,
 *  and ch2 = G R_s I = G V_s, each through its own divider into the ADC (IMP_LOSS between
 *  them): so ch1 - (2 + 2k) IMP_LOSS ch2 / 3G = G v / 3 in ch1's units, with k the range's own
 *  (HW.senseK). ch1 alone reads 1 + 2 R_s/Z high, +1.9 dB into 8 ohm; HIGH read with NORMAL's k, +1.4 dB. */
export function tipChannel(ch1, ch2, k = HW.senseK.normal) {
  const n = Math.min(ch1.length, ch2.length), c = (2 + 2 * k) * IMP_LOSS / (3 * HW.currentGain), u = new Float64Array(n);
  for (let i = 0; i < n; i++) u[i] = ch1[i] - c * ch2[i];
  return u;
}

/** The real tip gain, from the tip channel in Impedance mode at a known digital drive level
 *  (both as RMS fractions of full scale; detectMode's levelDb gives it). Refuses a sweep
 *  more than 1 dB above its range's nominal, or in HIGH unless HIGH was asked for. HIGH is
 *  recognised within 3 dB of its nominal, but the 1 dB rule still holds inside that: 12
 *  single faults put HIGH 1.1-3.0 dB hot into 8 ohm. Below nominal means the host's volume
 *  is down: safe, but the sweep plays quieter than asked.
 *  `nominal`, if given, is this unit's own { normal, high } in dB per unit of drive, read
 *  back at the factory (spec 13.3 item 1). The codec's DAC and ADC gain errors (+-10 % each,
 *  max; +-2 % typical) put a healthy unit anywhere from -1.83 to +1.66 dB off the design's
 *  nominal, which a 1 dB rule cannot absorb; they cancel against the unit's own read-back.
 *  Without it, the design's nominal. */
export function preflight(ch1Rms, driveRms, allowHigh = false, nominal = null) {
  const gainDb = db(ch1Rms / driveRms);
  const normalDb = nominal ? nominal.normal : db(PREFLIGHT.normal), highDb = nominal ? nominal.high : db(PREFLIGHT.high);
  const overNormal = gainDb - normalDb;
  if (Math.abs(gainDb - highDb) <= PREFLIGHT.highWindowDb) {
    const overHigh = gainDb - highDb;
    if (allowHigh && overHigh > PREFLIGHT.overTolDb) {
      return { range: "FAULT", gainDb, overNormalDb: overNormal, ok: false,
               message: `HIGH is ${overHigh.toFixed(1)} dB above its nominal: a hardware fault. Do not measure.` };
    }
    return { range: "HIGH", gainDb, overNormalDb: overNormal, ok: allowHigh,
             message: allowHigh ? "HIGH range, as asked." :
               "HIGH range is engaged. Slide RANGE to NORMAL, or confirm the earphone is in the coupler." };
  }
  if (overNormal > PREFLIGHT.overTolDb) {
    return { range: "FAULT", gainDb, overNormalDb: overNormal, ok: false,
             message: `The output is ${overNormal.toFixed(1)} dB above nominal: a hardware fault. Do not measure.` };
  }
  if (overNormal < -PREFLIGHT.overTolDb) {
    return { range: "NORMAL", gainDb, overNormalDb: overNormal, ok: true,
             message: `The host's volume is ${(-overNormal).toFixed(1)} dB down. Set the device volume to 100 %.` };
  }
  return { range: "NORMAL", gainDb, overNormalDb: overNormal, ok: true, message: "NORMAL range." };
}

/** Spec 12.13: is this a V4? Its USB identity is TI's generic one, shared by every PCM2900C
 *  product, so the signal is the signature: in Impedance mode the tip channel per unit of drive
 *  (detectMode's levelDb) sits at the design's NORMAL or HIGH nominal, within the codec's own
 *  spread (CAL.nominalWindowDb: its gain errors reach -1.83/+1.66 dB, R14). With the unit's
 *  calibration file, `nominal` holds it to its own read-back, within the pre-flight's 1 dB.
 *  Lower is either the host's volume or another device, and only 100 % tells which. */
export function identify(mode, levelDb, nominal = null) {
  const tol = nominal ? PREFLIGHT.overTolDb : CAL.nominalWindowDb;
  const ref = range => nominal ? nominal[range] : db(PREFLIGHT[range]);
  if (mode !== "impedance")
    return { v4: false, range: null, message: `MODE reads ${mode}, not Impedance: slide MODE to IMP. ` +
             "A device that never reads Impedance is not a V4 (spec 12.13)." };
  if (!Number.isFinite(levelDb)) return { v4: false, range: null, message: "No signal on the tip channel." };
  for (const range of ["normal", "high"])
    if (Math.abs(levelDb - ref(range)) <= tol) return { v4: true, range: range.toUpperCase(), message: "A V4." };
  // told against the nearer range: under one is its volume or another device, over is a fault or another device
  const name = levelDb < 0.5 * (ref("normal") + ref("high")) ? "normal" : "high", off = levelDb - ref(name);
  return { v4: false, range: null, message: off < 0
    ? `The tip reads ${(-off).toFixed(1)} dB under a V4's ${name.toUpperCase()}: set the device's volume to 100 %. ` +
      "A device that still reads low is not a V4 (spec 12.13)."
    : `The tip reads ${off.toFixed(1)} dB over a V4's ${name.toUpperCase()}: not a V4, or a fault. Do not measure.` };
}

// ---- impedance (spec 8) --------------------------------------------------------------
// Complex numbers are [re, im] pairs.
const cdiv = ([a, b], [c, d]) => { const m = c * c + d * d; return [(a * c + b * d) / m, (b * c - a * d) / m]; };

/** Z from the two channels, one channel driven, in NORMAL: Z = 3 G R_s K (V1/V2) - (2 + k)
 *  R_s. V1 and V2 are the channels' complex amplitudes at one frequency; K calibrates the
 *  channel gain ratio (1 = nominal). k is NORMAL's sense-bridge residual (HW.senseK): the idle
 *  ring sits at (1 + k) V_s, not V_s. Spec 8's formula leaves it out: 4.4 mohm, 0.05 % at 8 ohm.
 *  V1/V2 is the ADC's, IMP_LOSS under the circuit's, so it is divided by that first. */
export function zFromChannels(v1, v2, k = 1) {
  const [qr, qi] = cdiv(v1, v2);
  const s = 3 * HW.currentGain * HW.rSense * k / IMP_LOSS;
  return [s * qr - (2 + HW.senseK.normal) * HW.rSense, s * qi];
}

/** R_ref is always across the output: 1/Z = 1/Z_meas - 1/R_ref. */
export function removeRef(zMeas, rRef = HW.rRef) {
  const [yr, yi] = cdiv([1, 0], zMeas);
  return cdiv([1, 0], [yr - 1 / rRef, yi]);
}

/** Jack contact resistance, from a shorted plug read the same way, comes off in series. */
export function subtractContact(z, zShort) {
  return [z[0] - zShort[0], z[1] - zShort[1]];
}

/** How far a one-channel reading sits above the plug-referenced value, as a fraction,
 *  for a shared cable ground g: the idle side's driver shunts that wire. It cannot be
 *  removed from the readings (tests/test_ground_bias.py); the app states it. */
export function groundBias(zSelf, zOther, g) {
  return (g * zSelf / zOther) / (zSelf + g);
}

// ---- spectra -------------------------------------------------------------------------
/** In-place iterative radix-2 FFT; the length must be a power of two. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len >> 1; j++) {
        const a = i + j, b = a + (len >> 1);
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const pow2 = n => { let s = 1; while (s < n) s <<= 1; return s; };

/** Exponential sine sweep (Farina) from f0 to f1 over t seconds, with 10 ms raised-cosine
 *  fades so the ends do not click. */
export function logSweep(f0, f1, t, fs = FS) {
  const n = Math.round(t * fs), k = Math.log(f1 / f0), fade = Math.round(0.01 * fs);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / fs;
    let w = 1;
    if (i < fade) w = 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
    else if (i >= n - fade) w = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / fade);
    x[i] = w * Math.sin(2 * Math.PI * f0 * t / k * (Math.exp(tt * k / t) - 1));
  }
  return x;
}

/** The lag (samples, sub-sample by a parabola) at which resp best matches ref, searched
 *  over 0..maxLag. For the bulk latency of the play/record path. The board's output stage
 *  inverts (spec 7), so the peak is taken by size: its sign is the path's polarity, and
 *  the largest positive value of an inverted path is a side lobe hundreds of samples out. */
export function latency(ref, resp, maxLag = FS) {
  const n = pow2(Math.max(ref.length, resp.length) + maxLag);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(resp); br.set(ref);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) {                       // resp x conj(ref)
    const r = ar[i] * br[i] + ai[i] * bi[i], m = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = m;
  }
  fft(ar, ai, true);
  let best = 0;
  for (let k = 1; k <= Math.min(maxLag, n - 2); k++) if (Math.abs(ar[k]) > Math.abs(ar[best])) best = k;
  if (best < 1) return best;
  const s = Math.sign(ar[best]), a = s * ar[best - 1], b = s * ar[best], c = s * ar[best + 1], den = a - 2 * b + c;
  return best + (den !== 0 ? 0.5 * (a - c) / den : 0);
}

/** Welch H1 estimate of resp/ref, Hann frames of nfft with 50 % overlap, the coherence, and
 *  ref's power per bin (sxx, to weight bins by). ref and resp must already be aligned to within
 *  a small part of a frame. H1 takes ref's noise as a bias, |H1| = |H| / (1 + N/S): make ref
 *  the stronger channel. resp's noise only scatters it. */
export function transfer(ref, resp, nfft = 4096, fs = FS) {
  const bins = nfft / 2 + 1, len = Math.min(ref.length, resp.length);
  const sxx = new Float64Array(bins), syy = new Float64Array(bins);
  const sxr = new Float64Array(bins), sxi = new Float64Array(bins);
  const w = Float64Array.from({ length: nfft }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nfft));
  const xr = new Float64Array(nfft), xi = new Float64Array(nfft), yr = new Float64Array(nfft), yi = new Float64Array(nfft);
  let frames = 0;
  for (let s = 0; s + nfft <= len; s += nfft >> 1, frames++) {
    for (let i = 0; i < nfft; i++) { xr[i] = ref[s + i] * w[i]; yr[i] = resp[s + i] * w[i]; xi[i] = 0; yi[i] = 0; }
    fft(xr, xi); fft(yr, yi);
    for (let k = 0; k < bins; k++) {
      sxx[k] += xr[k] * xr[k] + xi[k] * xi[k];
      syy[k] += yr[k] * yr[k] + yi[k] * yi[k];
      sxr[k] += xr[k] * yr[k] + xi[k] * yi[k];          // conj(X) Y
      sxi[k] += xr[k] * yi[k] - xi[k] * yr[k];
    }
  }
  const f = new Float64Array(bins), re = new Float64Array(bins), im = new Float64Array(bins);
  const mag = new Float64Array(bins), coh = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    f[k] = k * fs / nfft;
    re[k] = sxx[k] > 0 ? sxr[k] / sxx[k] : 0;
    im[k] = sxx[k] > 0 ? sxi[k] / sxx[k] : 0;
    mag[k] = Math.hypot(re[k], im[k]);
    coh[k] = sxx[k] > 0 && syy[k] > 0 ? (sxr[k] ** 2 + sxi[k] ** 2) / (sxx[k] * syy[k]) : 0;
  }
  return { f, re, im, mag, coh, frames, sxx };
}

/** Group delay (samples) of a transfer function over [f1, f2]: a least-squares line
 *  through its unwrapped phase, weighted by coherence. Only bins at or above minCoh are
 *  unwrapped, as well as fitted: a noisy bin between two good ones can add a false 2 pi.
 *  Positive: resp lags ref. */
export function delaySamples(h, f1, f2, fs = FS, minCoh = 0.9) {
  let prev = null, off = 0, sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let k = 0; k < h.f.length; k++) {
    if (h.f[k] < f1 || h.f[k] > f2) continue;
    if (!(h.coh[k] >= minCoh)) continue;
    let ph = Math.atan2(h.im[k], h.re[k]);
    if (prev !== null) {
      while (ph + off - prev > Math.PI) off -= 2 * Math.PI;
      while (ph + off - prev < -Math.PI) off += 2 * Math.PI;
    }
    ph += off; prev = ph;
    const wgt = h.coh[k], x = 2 * Math.PI * h.f[k];
    sw += wgt; sx += wgt * x; sy += wgt * ph; sxx += wgt * x * x; sxy += wgt * x * ph;
  }
  const den = sw * sxx - sx * sx;
  if (!(sw > 0) || den === 0) return NaN;
  const slope = (sw * sxy - sx * sy) / den;             // rad per (rad/s)
  return -slope * fs;
}

function percentile(values, p) {
  const s = Float64Array.from(values).sort();
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : NaN;
}

// ---- MODE (spec 3): inferred from the signal, never trusted ------------------------------
/** "impedance" when the tip channel is flat against the drive and ch1/ch2 is PASSIVE. In
 *  Impedance mode the tip channel is G v / 3, flat for any load on the range's own k (ch1
 *  itself is not: a BA's swing moves its 2 R_s I share by over 1 dB), and ch1/ch2 is
 *  proportional to Z + (2 + k) R_s, whose real part cannot go negative.
 *  "measure" when ch1/ch2 is not passive, lags, or is far from flat: the acoustic path's
 *  pure delay turns its phase without bound, where an impedance's stays within 90
 *  degrees. The delay alone cannot decide: an inductive driver's current lags its
 *  voltage by L/R, up to ~3 samples, as long as the coupler's ~2.7 sample acoustic
 *  path. Otherwise "unknown", and the app asks. stim is the digital stimulus; the
 *  current channel (ch2) is the timing reference (spec 12.7). */
export function detectMode(stim, ch1, ch2, fs = FS) {
  const lag = Math.round(latency(stim, ch2));
  const aligned = x => x.subarray(Math.min(lag, x.length));
  const tipBand = k => {                              // the tip channel's level in band, on one k
    const h1 = transfer(stim, aligned(tipChannel(ch1, ch2, k)), 4096, fs), out = [];
    for (let b = 0; b < h1.f.length; b++)
      if (h1.f[b] >= 200 && h1.f[b] <= 8000 && h1.coh[b] >= 0.9 && h1.mag[b] > 0) out.push(db(h1.mag[b]));
    return out;
  };
  let inBand = tipBand(HW.senseK.normal);             // in HIGH's window, read on HIGH's own k
  if (inBand.length && Math.abs(percentile(inBand, 0.5) - db(PREFLIGHT.high)) <= PREFLIGHT.highWindowDb)
    inBand = tipBand(HW.senseK.high);
  const flatnessDb = inBand.length ? percentile(inBand, 0.95) - percentile(inBand, 0.05) : NaN;
  const h12 = transfer(ch2, ch1, 4096, fs);
  const delay = delaySamples(h12, 500, 8000, fs);
  let bins = 0, active = 0;
  for (let k = 0; k < h12.f.length; k++) {
    if (h12.f[k] < 200 || h12.f[k] > 16000 || h12.coh[k] < 0.9) continue;
    bins++;
    if (h12.re[k] < 0) active++;
  }
  const nonPassive = bins ? active / bins : NaN;
  let mode = "unknown";
  if (nonPassive <= 0.01 && flatnessDb <= 1.0) mode = "impedance";
  else if (nonPassive >= 0.05 || flatnessDb >= 3.0 || delay >= 1.5) mode = "measure";
  return { mode, flatnessDb, delaySamples: delay, nonPassive,
           levelDb: inBand.length ? percentile(inBand, 0.5) : NaN, latency: lag };
}

// ---- THD (spec 12.8) -----------------------------------------------------------------------
/** A THD test frequency near target: on a bin of an n-point record, with it and its first
 *  nHarm harmonics at least guardHz from every multiple of 1 kHz, where the USB frames
 *  put a noise comb. 997 Hz, the usual choice, is 3 Hz from a comb line. */
export function thdTone(target, n = FS, fs = FS, nHarm = 5, guardHz = 20) {
  const df = fs / n, k0 = Math.round(target / df);
  for (let step = 0; step * df < 1000; step++) {
    for (const k of step ? [k0 - step, k0 + step] : [k0]) {
      const f = k * df;
      if (f <= 0) continue;
      let ok = true;
      for (let h = 1; h <= nHarm && h * f < fs / 2; h++) {
        const fh = h * f;
        if (Math.abs(fh - 1000 * Math.round(fh / 1000)) < guardHz) { ok = false; break; }
      }
      if (ok) return f;
    }
  }
  return NaN;
}

const HALF = 4;                   // bins each side of a line: the Blackman-Harris main lobe

/** THD of a recorded tone near f0. Blackman-Harris 4-term window; the fundamental is found
 *  where it is, since play/record drift moves it by up to ~100 ppm; each line's power is
 *  summed over its main lobe, less the noise expected there. The floor is the median bin
 *  power beside the line over ln 2: noise bins are exponentially distributed, so that is
 *  their mean, and a stray spur cannot pull it up. A harmonic that does not clear the
 *  floor by 6 dB is "below the measurement floor": 3 dB false-alarmed ~13 % per line,
 *  6 dB false-alarms 2 lines in 1200 on pure noise (measured). If every harmonic is
 *  below, the THD returned is that threshold's bound, flagged. chainFloorPct is the chain's
 *  own THD at this level and tone, measured in spec 13.1 (codec, amp and mic together): a
 *  THD at or under it is the chain's, not the earphone's (belowChainFloor), however far the
 *  harmonics clear the noise. */
export function thd(x, f0, fs = FS, nHarm = 5, { chainFloorPct = null } = {}) {
  const n = pow2(x.length) === x.length ? x.length : pow2(x.length) >> 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  const a = [0.35875, 0.48829, 0.14128, 0.01168];
  for (let i = 0; i < n; i++) {
    const t = 2 * Math.PI * i / n;
    re[i] = x[i] * (a[0] - a[1] * Math.cos(t) + a[2] * Math.cos(2 * t) - a[3] * Math.cos(3 * t));
  }
  fft(re, im);
  const df = fs / n, p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  // the fundamental's peak, interpolated on the log spectrum
  const kn = Math.round(f0 / df);
  let kp = kn;
  for (let k = Math.max(1, kn - 20); k <= Math.min(n / 2 - 2, kn + 20); k++) if (p[k] > p[kp]) kp = k;
  const la = Math.log(p[kp - 1]), lb = Math.log(p[kp]), lc = Math.log(p[kp + 1]), den = la - 2 * lb + lc;
  const fMeas = (kp + (den !== 0 ? 0.5 * (la - lc) / den : 0)) * df;
  const lineSum = fc => {
    const kc = Math.round(fc / df);
    let s = 0;
    for (let k = kc - HALF; k <= kc + HALF; k++) if (k > 0 && k < n / 2) s += p[k];
    return s;
  };
  const floorNear = fc => {                              // mean noise per bin beside the line
    const kc = Math.round(fc / df), side = [];
    for (let k = kc - 60; k <= kc + 60; k++) if (k > 0 && k < n / 2 && Math.abs(k - kc) > 3 * HALF) side.push(p[k]);
    return percentile(side, 0.5) / Math.LN2;
  };
  const p1 = lineSum(fMeas) - (2 * HALF + 1) * floorNear(fMeas);
  const harmonics = [];
  let sum = 0, bound = 0, anyAbove = false;
  for (let h = 2; h <= nHarm && h * fMeas < fs / 2 - HALF * df; h++) {
    const fh = h * fMeas, noise = (2 * HALF + 1) * floorNear(fh), raw = lineSum(fh);
    const below = raw < 4 * noise;                       // 6 dB over the floor, or it is noise
    const ph = Math.max(raw - noise, 0);
    harmonics.push({ h, f: fh, levelDb: 10 * Math.log10(Math.max(ph, 1e-300) / p1), belowFloor: below });
    if (!below) { sum += ph; anyAbove = true; }
    bound += 4 * noise;
  }
  const value = Math.sqrt((anyAbove ? sum : bound) / p1);
  return { f0: fMeas, thdPct: 100 * value, thdDb: db(value), belowFloor: !anyAbove, harmonics,
           floorDb: 10 * Math.log10(floorNear(fMeas) / p1), chainFloorPct,
           belowChainFloor: chainFloorPct !== null && 100 * value <= chainFloorPct };
}

// ---- the curves the app shows ------------------------------------------------------------
const cmul = ([a, b], [c, d]) => [a * c - b * d, a * d + b * c];

/** The earphone's impedance across frequency from an Impedance-mode capture: the Welch
 *  ratio ch1/ch2 (one ADC clock, so no drift), through the spec 8 formula, less R_ref,
 *  less a shorted-plug curve if given (same nfft). Bins under minCoh are NaN. The result
 *  carries the shared-ground bias no sweep can remove (groundBias).
 *  The ratio is estimated on ch1 and inverted. An H1 estimate takes its reference's noise as
 *  a bias, |H1| = |H| / (1 + N/S): ch1 holds near -48 dBFS for any load at -20 dBFS, where
 *  ch2 falls with the load, and on ch2 a 300 ohm load read 0.9 % low (the codec's noise,
 *  TWIN_NOISE). Noise on the estimate's other channel only scatters it.
 *  NORMAL only (spec 7): on HIGH's unbalanced sense bridge (k = 0.64) the formula's (2 + k) R_s is
 *  NORMAL's, and a HIGH sweep reads 0.64 ohm high at 8 ohm (8 %), 0.83 at 300. Take it in NORMAL. */
export function impedanceCurve(ch1, ch2, { k = 1, skew = 1 / (2 * Math.PI * HW.currentPoleHz), zShort = null,
                                          nfft = 8192, minCoh = 0.95, fs = FS } = {}) {
  const h = transfer(ch1, ch2, nfft, fs), bins = h.f.length;
  const re = new Float64Array(bins).fill(NaN), im = new Float64Array(bins).fill(NaN);
  for (let b = 1; b < bins; b++) {
    if (h.coh[b] < minCoh) continue;
    // ch2 lags by the current amp's pole, so ch1/ch2 reads (1 + j 2 pi f skew) times too big
    const hb = cdiv([1, 0], cmul([h.re[b], h.im[b]], [1, 2 * Math.PI * h.f[b] * skew]));
    // zFromChannels takes V1 and V2; their ratio is all it uses, so V1/V2 = hb, V2 = 1
    let z = removeRef(zFromChannels(hb, [1, 0], k));
    if (zShort && Number.isFinite(zShort.re[b])) z = subtractContact(z, [zShort.re[b], zShort.im[b]]);
    re[b] = z[0]; im[b] = z[1];
  }
  const mag = re.map((r, b) => Math.hypot(r, im[b]));
  const phaseDeg = re.map((r, b) => Math.atan2(im[b], r) * 180 / Math.PI);
  return { f: h.f, re, im, mag, phaseDeg, coh: h.coh };
}

/** Sensitivity in dB SPL per volt at the tip, from a Measure-mode capture and the last
 *  impedance curve (same nfft). The drive voltage is the measured current times
 *  (Z || R_ref) (spec 3), so neither the host's volume nor play/record drift enters:
 *  mic V / tip V = K (ch1/ch2) G R_s / (preamp (Z || R_ref)). micDbvPa is the unit's
 *  calibrated mic sensitivity (IM73A135 datasheet: -38 dBV/Pa, +-1 dB). K, the unit's
 *  channel gain ratio (calibrateK), belongs here as in the impedance: ch1/ch2 carries the
 *  ADC's channel mismatch (5 % max), R_s's 1 % and the current amp's gain, all of which K
 *  holds. Take the mic calibration with the same K. skew takes the current amp's roll-off
 *  off |ch2| (0.1 % at 20 kHz), as impedanceCurve does. */
export function sensitivityCurve(ch1, ch2, zCurve, { k = 1, skew = 1 / (2 * Math.PI * HW.currentPoleHz), micDbvPa = -38,
                                                     nfft = 8192, minCoh = 0.95, fs = FS } = {}) {
  const h = transfer(ch2, ch1, nfft, fs), bins = h.f.length;
  const out = new Float64Array(bins).fill(NaN);
  const paPerVolt = 1 / 10 ** (micDbvPa / 20);
  for (let b = 1; b < bins; b++) {
    if (h.coh[b] < minCoh || !Number.isFinite(zCurve.re[b])) continue;
    const z = [zCurve.re[b], zCurve.im[b]];
    const zPar = cdiv(cmul(z, [HW.rRef, 0]), [z[0] + HW.rRef, z[1]]);          // Z || R_ref
    const ratio = cdiv(cmul([h.re[b], h.im[b]], [k * HW.currentGain * HW.rSense, 0]), cmul([HW.preampGain, 0], zPar));
    out[b] = db(Math.hypot(...ratio) / Math.hypot(1, 2 * Math.PI * h.f[b] * skew) * paPerVolt / 20e-6);
  }
  return { f: h.f, dbSplPerV: out, coh: h.coh };
}

/** K, the channel gain ratio, from a capture with the jack EMPTY (spec 8): the only load
 *  is R_ref, 1.00 k at 0.1 %, so the formula must read R_ref, and K is what makes it.
 *  Over 200 Hz-10 kHz; factory, and again on demand. The current channel's roll-off comes off
 *  first, as impedanceCurve takes it off, so K does not absorb the pole twice (the typical
 *  skew: the jack-empty capture is too faint to fit the unit's own).
 *  Here ch2 sits at -72 dBFS, 13-20 dB over the codec's noise per bin (TWIN_NOISE), and the
 *  estimate is built for that. The ratio is taken on ch1, as impedanceCurve takes it: on ch2,
 *  K read 2.5 % high. The bins are summed as cross-spectra in blocks of 16 (94 Hz), ch1's power
 *  weighting each, and only the blocks' magnitudes are added. A median of per-bin values
 *  scattered 0.3 % from capture to capture; a coherence gate, picking bins by their noise, read
 *  0.1 % high; a fitted delay slipped at the codec's worst noise (-0.9 %). Inside a block a
 *  delay between the ADC channels turns the phase by under 0.02 rad, so none is assumed. K
 *  repeats to 0.10 % (1 sigma) on the codec's typical noise and 0.17 % on its worst.
 *  Bins within guardHz of every 1 kHz are left out, as thdTone keeps clear of them: the USB
 *  frames put a comb there in both channels at once, which adds to the cross-spectrum in
 *  every frame, and a line 20 dB over the idle step's limit moved K 0.09 %. */
export function calibrateK(ch1, ch2, { skew = 1 / (2 * Math.PI * HW.currentPoleHz), nfft = 8192, block = 16,
                                       guardHz = 20, fs = FS } = {}) {
  const h = transfer(ch1, ch2, nfft, fs);
  let mags = 0, power = 0, sr = 0, si = 0, sw = 0, n = 0;
  for (let b = 1; b < h.f.length; b++) {
    if (h.f[b] < 200 || h.f[b] > 10000) continue;
    if (Math.abs(h.f[b] - 1000 * Math.round(h.f[b] / 1000)) < guardHz) { sr = si = sw = n = 0; continue; }   // no block spans it
    const g = h.sxx[b] * Math.hypot(1, 2 * Math.PI * h.f[b] * skew);     // the pole's roll-off off |ch2|
    sr += g * h.re[b]; si += g * h.im[b]; sw += h.sxx[b];
    if (++n === block) { mags += Math.hypot(sr, si); power += sw; sr = si = sw = n = 0; }
  }
  // Z = 3 G R_s K |V1/V2| / IMP_LOSS - 2 R_s = R_ref (it is real: R_ref alone; k cancels here),
  // V2/V1 the sum: K is then the channels' mismatch alone, which Measure mode shares
  return power > 0 ? (HW.rRef + 2 * HW.rSense) * IMP_LOSS * mags / power / (3 * HW.currentGain * HW.rSense) : NaN;
}

/** The current channel's lag behind ch1, in seconds, from an Impedance-mode capture of a
 *  resistive load: a reference plug, whose own phase is 0 (spec 13.3). The current amp's
 *  closed-loop pole lags ch2 by 1/(2 pi f_p): 0.33 us typical (HW.currentPoleHz), 2.6 degrees
 *  of impedance phase at 20 kHz. Its GBP spreads part to part, so each unit's own is stored
 *  with K. The jack-empty capture is too faint for it at -20 dBFS: ch2 sits near -72 dBFS and
 *  the fit scatters by +-0.15 us, where a 32 ohm plug gives +-0.003 us. */
export function calibrateSkew(ch1, ch2, { nfft = 8192, f1 = 1000, f2 = 16000, fs = FS } = {}) {
  return -delaySamples(transfer(ch2, ch1, nfft, fs), f1, f2, fs, 0.95) / fs;
}

// ---- the unit's calibration file (app/README.md) ---------------------------------------------
/** What a calibration file may hold, per channel. The tip read-back (`nominal`, per range) is
 *  held to the codec's own spread: its DAC and ADC gain errors put a healthy unit -1.83 to
 *  +1.66 dB off the design's (spec R14), the margin left for the ADC divider and the resistors.
 *  HIGH over NORMAL is 0.1 % resistors, and the codec's errors are common to both ranges, so
 *  that step holds to 0.2 dB: a host volume moved between the two read-backs shows there. K:
 *  the ADC channels' 5 % (SBFS039) and R_s's 1 %. The skew: the current amp's pole, 0.33 us
 *  typical, a factor of 3 either way (the TLV9064's GBP has no minimum given). A delay between
 *  the ADC channels, which the datasheet does not state, would read here too: a whole sample is
 *  21 us, and impedanceCurve's pole model (1 + j w skew) would then read |Z| 64 % high at 10 kHz.
 *  It is refused, and step 4's plug fails on it. */
export const CAL = Object.freeze({
  format: "reference-one-v4-calibration", version: 1,
  nominalWindowDb: 2.0, rangeStepTolDb: 0.2,
  k: Object.freeze([0.9, 1.1]), skew: Object.freeze([0.1e-6, 1.0e-6]),
});

/** What is wrong with one channel's calibration ({ k, skew, nominal: { normal, high } }), as
 *  sentences: none when every value is one a healthy unit gives (CAL). */
export function calibrationProblems({ k, skew, nominal } = {}) {
  const out = [], num = x => typeof x === "number" && Number.isFinite(x);
  if (!num(k)) out.push(`K is ${JSON.stringify(k)}, not a number.`);
  else if (k < CAL.k[0] || k > CAL.k[1]) out.push(`K ${k} is outside ${CAL.k[0]} to ${CAL.k[1]}.`);
  if (!num(skew)) out.push(`The skew is ${JSON.stringify(skew)}, not a number.`);
  else if (skew < CAL.skew[0] || skew > CAL.skew[1])
    out.push(`The skew ${(1e6 * skew).toFixed(3)} us is outside ${+(1e6 * CAL.skew[0]).toFixed(3)} to ${+(1e6 * CAL.skew[1]).toFixed(3)} us.`);
  for (const range of ["normal", "high"]) {
    const v = nominal?.[range], design = db(PREFLIGHT[range]), name = range.toUpperCase();
    if (!num(v)) out.push(`No ${name} read-back.`);
    else if (Math.abs(v - design) > CAL.nominalWindowDb)
      out.push(`${name} reads ${Math.abs(v - design).toFixed(2)} dB ${v < design ? "under" : "over"} the design's ` +
               `(${design.toFixed(2)} dB): more than the codec's gain errors explain (spec R14).`);
  }
  if (num(nominal?.normal) && num(nominal?.high)) {
    const step = nominal.high - nominal.normal, design = db(PREFLIGHT.high / PREFLIGHT.normal);
    if (Math.abs(step - design) > CAL.rangeStepTolDb)
      out.push(`HIGH sits ${step.toFixed(2)} dB over NORMAL, not ${design.toFixed(2)}: the volume moved between ` +
               "the two read-backs, or RANGE is mis-wired.");
  }
  return out;
}

/** One channel's calibration, "L" or "R", from a unit's calibration file: { k, skew, nominal },
 *  as impedanceCurve and sensitivityCurve take k and skew and preflight takes nominal. The
 *  whole file is refused, with the reason, if it is another format or version or either
 *  channel holds a value no healthy unit gives: the read-back sets the pre-flight's limit. A file
 *  the bench made in its rehearsal mode, on the digital twin, carries `simulated` and is refused. */
export function calibrationFor(file, side) {
  if (file?.format !== CAL.format || file?.version !== CAL.version)
    throw new Error(`Not a V4 calibration file (format ${JSON.stringify(file?.format)}, version ${JSON.stringify(file?.version)}).`);
  if (file.simulated) throw new Error("This calibration file came from the bench page's digital twin, not a unit.");
  if (side !== "L" && side !== "R") throw new Error(`No channel ${JSON.stringify(side)}: L or R.`);
  const ch = s => ({ k: file.k?.[s], skew: file.skew?.[s], nominal: file.nominal?.[s] });
  for (const s of ["L", "R"]) {
    const problems = calibrationProblems(ch(s));
    if (problems.length) throw new Error(`Calibration file, channel ${s}: ${problems.join(" ")}`);
  }
  const { k, skew, nominal } = ch(side);
  return { k, skew, nominal: { normal: nominal.normal, high: nominal.high } };
}

// ---- a digital twin, for self-tests with no hardware ----------------------------------------
/** The noise each channel records, dBFS (rms, re a full-scale sine, white to fs/2), from the
 *  research budget (calc/zbudget.py): the ADC's 89 dB dynamic range (81 dB min, SBFS039) on
 *  both, and on ch2 the current amp's 16 nV/rtHz at its noise gain of 21 as well. */
export const TWIN_NOISE = Object.freeze({
  typical: Object.freeze({ ch1: -85.9, ch2: -81.2 }),
  worst: Object.freeze({ ch1: -77.9, ch2: -76.7 }),
});

/** The two channels the board would record for a drive (at the DAC, as a fraction of full
 *  scale) in Impedance mode. The range's gain, inverted as the output stage inverts (spec 7),
 *  gives the source voltage G v; each output also follows the sleeve by (1 + k) (HW.senseK),
 *  so U = G v + k V_s across the load z(f) (ohm, complex [re, im]) and R_ref, and the idle
 *  ring sits at (1 + k) V_s over its own R_ref. V_s = R_s times all the current. ch1 =
 *  (V_tip + V_ring)/3 through the summing node's divider (HW.adcDividerImp) and ch2 = G R_s I
 *  through the 1 k's (HW.adcDivider), the current amp rolling off at currentPoleHz, both
 *  delayed by `latency` samples. One channel driven; the ring carries
 *  no earphone. `noise` ({ ch1, ch2 } in dBFS, as TWIN_NOISE) adds the codec's noise and then
 *  its 16-bit grid; without it the channels are exact. For bench self-tests only. */
export function simulateCapture(drive, z, { high = false, latency = 4800, pad = 1 << 18, fs = FS,
                                            currentPoleHz = HW.currentPoleHz, noise = null, seed = 1 } = {}) {
  const g = -(high ? HW.gainHigh : HW.gainNormal), ks = high ? HW.senseK.high : HW.senseK.normal;
  const n = pad, dr = new Float64Array(n), di = new Float64Array(n), rs = HW.rSense, yRef = 1 / HW.rRef;
  dr.set(drive);
  fft(dr, di);
  const c1r = new Float64Array(n), c1i = new Float64Array(n), c2r = new Float64Array(n), c2i = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const kk = k <= n / 2 ? k : k - n, f = Math.abs(kk) * fs / n;
    const [zr, zi0] = f > 0 ? z(f) : z(1e-3);
    const zi = kk < 0 ? -zi0 : zi0, m = zr * zr + zi * zi;
    const ya = [zr / m + yRef, -zi / m];                         // the load and R_ref
    // V_s = R_s (ya U + k V_s / R_ref) with U = G v + k V_s: V_s per volt of G v
    const vs = cdiv([rs * ya[0], rs * ya[1]], [1 - ks * rs * (ya[0] + yRef), -ks * rs * ya[1]]);
    const d1 = HW.adcDividerImp / 3, d2 = HW.adcDivider * HW.currentGain;          // each its own divider
    const h1 = [(1 + ks * vs[0] + (2 + ks) * vs[0]) * d1, (ks * vs[1] + (2 + ks) * vs[1]) * d1];
    const h2 = cdiv([d2 * vs[0], d2 * vs[1]], [1, kk * fs / n / currentPoleHz]);   // the amp's pole
    const ph = -2 * Math.PI * kk / n * latency, er = Math.cos(ph) * g, ei = Math.sin(ph) * g;
    const a = dr[k], b = di[k];
    const u = [a * er - b * ei, a * ei + b * er];                // G v, delayed
    c1r[k] = u[0] * h1[0] - u[1] * h1[1]; c1i[k] = u[0] * h1[1] + u[1] * h1[0];
    c2r[k] = u[0] * h2[0] - u[1] * h2[1]; c2i[k] = u[0] * h2[1] + u[1] * h2[0];
  }
  fft(c1r, c1i, true); fft(c2r, c2i, true);
  if (noise) {
    let s = seed;                                                // Park-Miller, then Box-Muller
    const gauss = () => { s = (s * 16807) % 2147483647; const u = s / 2147483647;
      s = (s * 16807) % 2147483647; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * s / 2147483647); };
    for (const [x, dbfs] of [[c1r, noise.ch1], [c2r, noise.ch2]]) {
      const sd = Math.SQRT1_2 * 10 ** (dbfs / 20);
      for (let i = 0; i < n; i++) x[i] = Math.max(-1, Math.min(32767 / 32768, Math.round((x[i] + sd * gauss()) * 32768) / 32768));
    }
  }
  return { ch1: c1r, ch2: c2r };
}
