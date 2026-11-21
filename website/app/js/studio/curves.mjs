/**
 * RndB Measure - curves on the app's grid, and the rules for drawing them together.
 * No DOM and no audio, so Node tests it (hardware/reference_one_v4/tests/website_studio_curves.test.mjs).
 * Every curve the studio holds is resampled onto GRID, the 300 log-spaced points analysis.js
 * extracts onto, so curves can be averaged and compared point for point.
 */
export const GRID_POINTS = 300;
export const GRID = Array.from({ length: GRID_POINTS }, (_, i) => 20 * Math.pow(1000, i / (GRID_POINTS - 1)));

/**
 * Linear interpolation at f, as analysis.js's _valueAt: between a gap and a value is a gap. A
 * point that lands on a frequency (to within float error) keeps that point's value, so a curve
 * resampled onto its own grid comes back as it was and a gap does not spread to its neighbour.
 */
export function valueAt(freqs, mags, f) {
    const n = freqs.length;
    if (!n) return NaN;
    if (f <= freqs[0]) return mags[0];
    if (f >= freqs[n - 1]) return mags[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (freqs[m] < f) lo = m; else hi = m;
    }
    const t = (f - freqs[lo]) / (freqs[hi] - freqs[lo]);
    if (t < 1e-9) return mags[lo];
    if (t > 1 - 1e-9) return mags[hi];
    return mags[lo] * (1 - t) + mags[hi] * t;
}

/** A curve on GRID. */
export const onGrid = (freqs, mags) => GRID.map(f => valueAt(freqs, mags, f));

/** REW's RMS average: 10·log10 of the mean of 10^(dB/10). A band any curve lacks stays a gap. */
export function rmsAverage(curves) {
    if (!curves.length) return [];
    return curves[0].map((_, i) => {
        let sum = 0;
        for (const c of curves) {
            if (!Number.isFinite(c[i])) return NaN;
            sum += Math.pow(10, c[i] / 10);
        }
        return 10 * Math.log10(sum / curves.length);
    });
}

/** A curve's kind: 'relative' when normalised, else its unit. Two curves of one kind share a scale. */
export const kindOf = (d = {}) => (d.normalizedAt ? 'relative' : (d.unit || 'dB'));

/** A measured level: dB SPL under an absolute calibration, or a V4's dB SPL/V. */
export const isAbsolute = (d = {}) => !d.normalizedAt && /SPL/.test(d.unit || '');

/**
 * How far to shift each shown curve: shown is [{ mags, diag }] on GRID, in list order, and the
 * first sets the scale. Normalize on (hz > 0): all meet the first at hz. Off: a curve of the
 * first one's kind stays as measured, so two V4 earphones keep their sensitivity difference;
 * any other meets the first at 1 kHz and says so.
 */
export function placement(shown, normalizeHz) {
    if (!shown.length) return [];
    const at = (c, f) => valueAt(GRID, c.mags, f);
    const ref = shown[0];
    if (normalizeHz > 0) {
        const r = at(ref, normalizeHz);
        return shown.map(c => {
            const s = r - at(c, normalizeHz);
            return { shift: Number.isFinite(s) ? s : 0, note: '' };
        });
    }
    const k0 = kindOf(ref.diag);
    return shown.map(c => {
        if (kindOf(c.diag) === k0) return { shift: 0, note: '' };
        const s = at(ref, 1000) - at(c, 1000);
        return Number.isFinite(s) ? { shift: s, note: ' (matched at 1 kHz)' } : { shift: 0, note: '' };
    });
}

/** The shift that puts a target on the first shown curve at the normalize frequency (1 kHz when off). */
export function targetShift(refMags, targetMags, normalizeHz) {
    const f = normalizeHz > 0 ? normalizeHz : 1000;
    const s = valueAt(GRID, refMags, f) - valueAt(GRID, targetMags, f);
    return Number.isFinite(s) ? s : 0;
}

/** The largest and the mean |L - R| over the bands both have, up to fMax. Null with none in common. */
export function lrDifference(l, r, fMax = 10000) {
    let max = 0, sum = 0, bands = 0;
    for (let i = 0; i < GRID.length && GRID[i] <= fMax; i++) {
        const d = Math.abs(l[i] - r[i]);
        if (!Number.isFinite(d)) continue;
        max = Math.max(max, d);
        sum += d;
        bands++;
    }
    return bands ? { max, mean: sum / bands, bands } : null;
}

/** The axis top: the highest shown point with at least 1 dB above it, rounded up to 5 dB. */
export function axisTop(curves, fallback = 10) {
    let hi = -Infinity;
    for (const c of curves) for (const v of c) if (Number.isFinite(v) && v > hi) hi = v;
    return Number.isFinite(hi) ? 5 * Math.ceil((hi + 1) / 5) : fallback;
}
