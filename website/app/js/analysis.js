/**
 * RndB Measure - Signal Analysis Engine
 *
 * Sweep deconvolution -> impulse response -> frequency response, plus
 * smoothing, CSD, channel matching and EQ generation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE USED TO DO, AND WHY IT MATTERS
 *
 * extractFR() previously IGNORED its `recordedBlob` argument entirely and
 * returned a curve synthesised from a sum of Gaussians plus Math.random().
 * Both call sites passed `null` for the recording. There was no FFT anywhere
 * in the codebase. Because the random seed changed per call, it produced
 * convincing shot-to-shot variation - so two IEMs could be "compared" and the
 * difference would be nothing but a random number generator.
 *
 * That is the worst failure mode a measurement tool can have: it looked like
 * it was working. The synthesiser is deleted. If there is no usable capture
 * this file THROWS - it does not guess.
 * ---------------------------------------------------------------------------
 */
class AnalysisEngine {
    constructor() {
        this.measurements = [];
        this.channels = { left: null, right: null };
        // A stored measurement that later ones are divided by.
        // See setCalibration(): this is RELATIVE, not absolute SPL.
        this.calibration = null;
    }

    // =======================================================================
    // The measurement chain
    // =======================================================================

    /**
     * Turn a captured sweep into a frequency response.
     *
     * @param {object} capture   from AudioEngine.playSweep():
     *        {Float32Array} recording  what came back from the microphone
     *        {Float32Array} reference  the sweep that was played, sample-exact
     *        {number}       sampleRate
     * @param {object} [opts]
     *        gateMs      length of the impulse-response window (default 200)
     *        preMs       how much to keep before the peak (default 2)
     *        regDb       deconvolution regularisation, dB below peak (40)
     *        points      output points, log spaced 20 Hz - 20 kHz (300)
     *        normalizeAt normalise to 0 dB at this frequency; 0 disables (1000)
     *        calibrate   divide by the stored calibration if present (true)
     * @returns {object} { freqs, magnitudes, ir, diagnostics, label }
     */
    extractFR(capture, opts = {}) {
        const { recording, reference, sampleRate = 48000 } = capture || {};

        if (!recording || !reference || !recording.length || !reference.length) {
            throw new Error(
                'extractFR needs both the recorded signal and the reference sweep. ' +
                'Without a real capture there is no measurement - this used to ' +
                'return a synthesised curve, which is why it now refuses.');
        }

        const gateMs = opts.gateMs ?? 200;
        const preMs = opts.preMs ?? 2;
        const regDb = opts.regDb ?? 40;
        const points = opts.points ?? 300;
        // An absolute calibration carries dB SPL. Normalising to 0 dB at 1 kHz
        // would discard exactly the thing it was measured to provide.
        const absolute = opts.calibrate !== false && this.calibration &&
                         this.calibration.absoluteSpl;
        const normalizeAt = opts.normalizeAt ?? (absolute ? 0 : 1000);
        const useCal = opts.calibrate !== false;

        const ir = this._deconvolve(recording, reference, regDb);
        const gated = this._gate(ir, sampleRate, gateMs, preMs);
        const spec = this._spectrum(gated.window, sampleRate);
        const out = this._toLogBands(spec.freqs, spec.mags, points);

        const diagnostics = this._diagnose(recording, ir, gated, sampleRate);

        if (useCal && this.calibration) {
            out.magnitudes = this._applyCalibration(out.freqs, out.magnitudes);
            diagnostics.calibrated = true;
            diagnostics.unit = this.calibration.absoluteSpl ? 'dB SPL' : 'dB rel';
            diagnostics.validBand = this.calibration.validBand || null;
            const usable = out.magnitudes.filter(isFinite).length;
            if (usable < out.magnitudes.length) {
                diagnostics.warnings.push(
                    `No calibration outside ${this.calibration.validBand[0].toFixed(0)}-` +
                    `${this.calibration.validBand[1].toFixed(0)} Hz - shown as a gap.`);
            }
        } else {
            diagnostics.calibrated = false;
            diagnostics.unit = 'dB rel';
        }

        if (normalizeAt > 0) {
            const ref = this._valueAt(out.freqs, out.magnitudes, normalizeAt);
            if (isFinite(ref)) out.magnitudes = out.magnitudes.map(m => m - ref);
            diagnostics.normalizedAt = normalizeAt;
        }

        return {
            freqs: out.freqs,
            magnitudes: out.magnitudes,
            ir: gated.window,
            irSampleRate: sampleRate,
            diagnostics,
            label: 'Measurement',
        };
    }

    /**
     * Regularised spectral deconvolution.
     *
     *     H = REC * conj(REF) / (|REF|^2 + eps)
     *
     * Dividing straight through by REF blows up wherever the sweep has no
     * energy - below 20 Hz, above 20 kHz, and in any notch - turning noise
     * into enormous spurious peaks. eps is set relative to the strongest bin,
     * so those regions decay to zero instead of exploding.
     *
     * This form works for ANY known reference signal, which matters because
     * the app can play either a log chirp or a stepped sine. A time-reversed
     * inverse filter would only be correct for the chirp.
     */
    _deconvolve(rec, ref, regDb) {
        // Linear (not circular) convolution needs room for both signals.
        const n = FFT.nextPow2(rec.length + ref.length);
        const fft = new FFT(n);

        const recRe = FFT.pad(rec, n), recIm = new Float64Array(n);
        const refRe = FFT.pad(ref, n), refIm = new Float64Array(n);
        fft.forward(recRe, recIm);
        fft.forward(refRe, refIm);

        let maxPow = 0;
        for (let k = 0; k < n; k++) {
            const p = refRe[k] * refRe[k] + refIm[k] * refIm[k];
            if (p > maxPow) maxPow = p;
        }
        const eps = maxPow * Math.pow(10, -regDb / 10);

        const hRe = new Float64Array(n), hIm = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            const ar = recRe[k], ai = recIm[k];
            const br = refRe[k], bi = -refIm[k];             // conj(REF)
            const den = refRe[k] * refRe[k] + refIm[k] * refIm[k] + eps;
            hRe[k] = (ar * br - ai * bi) / den;
            hIm[k] = (ar * bi + ai * br) / den;
        }
        fft.inverse(hRe, hIm);
        return hRe;                                          // real impulse response
    }

    /**
     * Window the impulse response around its peak.
     *
     * The peak position IS the round-trip latency - USB out, DAC, amp, the
     * acoustic path, the microphone, USB back - so nothing has to align the
     * two clocks by hand; finding the peak does it.
     *
     * GATE LENGTH IS A RESOLUTION LIMIT, not a quality knob. A window of T
     * seconds cannot resolve anything below about 1/T Hz, so a 5 ms gate -
     * normal for gating room reflections out of a loudspeaker measurement -
     * would put the low-frequency limit at 200 Hz and quietly invent the bass
     * below it. A sealed coupler has no room reflections to gate, so the
     * default is long (200 ms -> ~5 Hz) and the window only tapers the noise
     * tail away.
     */
    _gate(ir, sampleRate, gateMs, preMs) {
        const half = ir.length >> 1;                 // second half wraps around
        let peak = 0, peakVal = 0;
        for (let i = 0; i < half; i++) {
            const v = Math.abs(ir[i]);
            if (v > peakVal) { peakVal = v; peak = i; }
        }

        const pre = Math.max(1, Math.round((preMs / 1000) * sampleRate));
        const len = Math.max(64, Math.round((gateMs / 1000) * sampleRate));
        const start = Math.max(0, peak - pre);
        const win = new Float64Array(len);
        for (let i = 0; i < len; i++) {
            const src = start + i;
            win[i] = src < ir.length ? ir[src] : 0;
        }

        // Short raised-cosine rise into the peak, long fall across the tail.
        for (let i = 0; i < pre; i++) {
            win[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / pre));
        }
        const fall = Math.max(16, Math.floor(len * 0.25));
        for (let i = 0; i < fall; i++) {
            win[len - fall + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / fall));
        }
        return { window: win, peak, peakVal, start, length: len };
    }

    /** Magnitude spectrum of a real signal, in dB, on linear frequency bins. */
    _spectrum(sig, sampleRate) {
        const n = FFT.nextPow2(sig.length);
        const fft = new FFT(n);
        const re = FFT.pad(sig, n), im = new Float64Array(n);
        fft.forward(re, im);

        const bins = n / 2;
        const freqs = new Float64Array(bins);
        const mags = new Float64Array(bins);
        for (let k = 0; k < bins; k++) {
            freqs[k] = (k * sampleRate) / n;
            const p = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
            mags[k] = 20 * Math.log10(p > 1e-12 ? p : 1e-12);
        }
        return { freqs, mags };
    }

    /**
     * Resample a linear-bin spectrum onto log-spaced points.
     *
     * Averaging in the POWER domain, not in dB: dB is already a logarithm, and
     * averaging logs biases every band low wherever the response is uneven.
     */
    _toLogBands(freqs, mags, points, fMin = 20, fMax = 20000) {
        const outF = new Array(points);
        const outM = new Array(points);
        const ratio = Math.pow(fMax / fMin, 1 / (points - 1));
        const df = freqs[1] - freqs[0];
        const edge = Math.sqrt(ratio);

        for (let i = 0; i < points; i++) {
            const f = fMin * Math.pow(ratio, i);
            outF[i] = f;
            let k0 = Math.ceil((f / edge) / df);
            let k1 = Math.floor((f * edge) / df);
            k0 = Math.max(0, k0); k1 = Math.min(freqs.length - 1, k1);

            if (k1 >= k0) {
                let sum = 0;
                for (let k = k0; k <= k1; k++) sum += Math.pow(10, mags[k] / 10);
                outM[i] = 10 * Math.log10(sum / (k1 - k0 + 1));
            } else {
                // Band narrower than one FFT bin - always true at the bottom of
                // the range. Interpolate between neighbouring bins instead.
                const x = f / df;
                const a = Math.max(0, Math.min(freqs.length - 1, Math.floor(x)));
                const b = Math.min(freqs.length - 1, a + 1);
                const t = x - a;
                outM[i] = mags[a] * (1 - t) + mags[b] * t;
            }
        }
        return { freqs: outF, magnitudes: outM };
    }

    /**
     * Numbers that say whether the measurement can be trusted. A measurement
     * that does not report its own validity is half a tool - a clipped capture
     * and a clean one draw equally confident-looking curves.
     */
    _diagnose(recording, ir, gated, sampleRate) {
        // Clipping is FLAT TOPS, not a peak near full scale - and the
        // threshold cannot be a fixed 0.999, because the capture is not
        // necessarily normalised. Measured on the real Reference One, Windows
        // hands this page samples peaking at 9.0 (+19 dBFS) with no clipping
        // whatsoever: float audio does not clip, and the endpoint gain is
        // applied downstream of the ADC. A fixed threshold called that capture
        // clipped when its longest run at maximum was ONE sample.
        //
        // So: find the peak, then look for consecutive samples sitting at it.
        // That is scale-independent and is what clipping actually looks like.
        let peak = 0, sum = 0;
        for (let i = 0; i < recording.length; i++) {
            const a = Math.abs(recording[i]);
            if (a > peak) peak = a;
            sum += recording[i] * recording[i];
        }
        const rms = Math.sqrt(sum / recording.length);
        let run = 0, worstRun = 0;
        const flat = peak * 0.9999;
        for (let i = 0; i < recording.length; i++) {
            if (Math.abs(recording[i]) >= flat) { if (++run > worstRun) worstRun = run; }
            else run = 0;
        }
        const clipped = worstRun >= 3 && peak > 0.02;

        // Signal energy inside the gate vs energy well after it, which can only
        // be noise once the impulse response has decayed.
        let sig = 0;
        for (let i = 0; i < gated.window.length; i++) sig += gated.window[i] ** 2;
        const nStart = Math.min(ir.length - 1, gated.start + gated.length * 2);
        const nEnd = Math.min(ir.length, nStart + gated.length);
        let noise = 0, nCount = 0;
        for (let i = nStart; i < nEnd; i++) { noise += ir[i] * ir[i]; nCount++; }
        const noiseMean = nCount ? noise / nCount : 0;
        const sigMean = sig / gated.window.length;
        const snrDb = noiseMean > 0 ? 10 * Math.log10(sigMean / noiseMean) : Infinity;

        const db = v => (v > 1e-9 ? 20 * Math.log10(v) : -Infinity);
        return {
            latencyMs: (gated.peak / sampleRate) * 1000,
            inputPeakDb: db(peak),
            inputRmsDb: db(rms),
            clipped,
            clipRun: worstRun,
            snrDb,
            gateMs: (gated.length / sampleRate) * 1000,
            warnings: [
                clipped && `Input clipped (${worstRun} samples pinned) - lower the sweep level.`,
                peak < 0.01 && 'Input very quiet - raise the level, or check the coupler seal.',
                snrDb < 20 && `Low signal-to-noise (${snrDb.toFixed(0)} dB) - treat this curve as unreliable.`,
            ].filter(Boolean),
        };
    }

    // =======================================================================
    // Calibration
    // =======================================================================

    /**
     * Store a measurement to divide later ones by.
     *
     * BE CLEAR ABOUT WHAT THIS IS. Without a calibrated reference microphone
     * it cannot produce absolute SPL, and it cannot make this coupler match a
     * published 711 curve - the bore is not the IEC canal diameter. What it
     * DOES remove is everything common to every measurement on this rig: the
     * microphone response, the coupler resonance, the DAC and the amplifier.
     * That makes IEMs comparable AGAINST EACH OTHER here, which is the job.
     */
    setCalibration(fr, opts = {}) {
        if (!fr || !fr.freqs || !fr.magnitudes) throw new Error('need a measurement');
        // Refuse to silently replace a substitution calibration with a
        // relative one. They are not interchangeable: the loaded one carries
        // absolute dB SPL measured against a known reference, and overwriting
        // it downgrades every later measurement without saying so.
        if (this.calibration && this.calibration.absoluteSpl && !opts.force) {
            throw new Error(
                'An absolute (dB SPL) calibration is loaded. Re-calibrating here ' +
                'would replace it with a relative one and lose the SPL scale. ' +
                'Pass {force:true} if that is genuinely what you want.');
        }
        this.calibration = {
            freqs: fr.freqs.slice(),
            magnitudes: fr.magnitudes.slice(),
            takenAt: new Date().toISOString(),
            relative: true,
        };
        return this.calibration;
    }

    clearCalibration() { this.calibration = null; }

    /**
     * Load a substitution calibration produced against a known measurement of
     * a known earphone. Unlike setCalibration(), this one carries absolute
     * level and a VALID BAND - the range over which repeat runs actually
     * agreed. Outside that range there is no correction and the measurement
     * reports nothing rather than something invented.
     */
    async loadCalibration(url) {
        const d = await fetch(url).then(r => {
            if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
            return r.json();
        });
        const corr = d.correction_db.map(v => (v === null ? NaN : v));
        this.calibration = {
            freqs: d.freqs,
            correction: corr,
            validBand: d.valid_band_hz,
            absoluteSpl: !!d.absolute_spl,
            level_dBFS: d.level_dBFS,
            source: d.source,
            relative: false,
        };
        return this.calibration;
    }

    _applyCalibration(freqs, mags) {
        const c = this.calibration;
        // setCalibration() stores a measurement to divide out, so it
        // SUBTRACTS. loadCalibration() stores reference-minus-measured, so it
        // ADDS. Same field name would have silently inverted one of them.
        if (!c.correction) {
            return mags.map((m, i) => m - this._valueAt(c.freqs, c.magnitudes, freqs[i]));
        }
        const [lo, hi] = c.validBand || [-Infinity, Infinity];
        return mags.map((m, i) => {
            const f = freqs[i];
            if (f < lo || f > hi) return NaN;      // no correction was measured here
            const k = this._valueAt(c.freqs, c.correction, f);
            return isFinite(k) ? m + k : NaN;
        });
    }

    /** Linear interpolation of a curve at one frequency. */
    _valueAt(freqs, mags, f) {
        if (f <= freqs[0]) return mags[0];
        if (f >= freqs[freqs.length - 1]) return mags[mags.length - 1];
        let i = 1;
        while (i < freqs.length && freqs[i] < f) i++;
        const t = (f - freqs[i - 1]) / (freqs[i] - freqs[i - 1]);
        return mags[i - 1] * (1 - t) + mags[i] * t;
    }

    // =======================================================================
    // Derived views
    // =======================================================================

    /** Apply fractional-octave smoothing. */
    smooth(freqs, magnitudes, fraction) {
        if (fraction === 0 || !magnitudes) return magnitudes;
        const sm = [];
        for (let i = 0; i < freqs.length; i++) {
            const f = freqs[i];
            const bw = f / fraction;
            let sum = 0, count = 0;
            // A gap (NaN) stays a gap, and does not spread into the bands around it.
            for (let j = 0; j < freqs.length; j++) {
                if (Math.abs(freqs[j] - f) <= bw / 2 && isFinite(magnitudes[j])) {
                    sum += magnitudes[j];
                    count++;
                }
            }
            sm.push(count > 0 && isFinite(magnitudes[i]) ? sum / count : magnitudes[i]);
        }
        return sm;
    }
}

window.analysis = new AnalysisEngine();
