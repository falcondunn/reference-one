/**
 * RndB Measure - the EQ: Robert Bristow-Johnson's Audio EQ Cookbook biquads at 48 kHz, their sum
 * and preamp, AutoEQ and channel match, and the files players read: APO and AutoEq's
 * ParametricEQ.txt, Wavelet's GraphicEQ, CSV and JSON. No DOM and no audio: nothing here plays.
 * Tests: hardware/reference_one_v4/tests/website_studio_peq.test.mjs.
 */
import { GRID, valueAt } from './curves.mjs?v=2026-11-01.3';

export const FS = 48000;
export const TYPES = ['PK', 'LSC', 'HSC', 'HPQ', 'LPQ'];
const DENSE = Array.from({ length: 481 }, (_, i) => 20 * Math.pow(1000, i / 480));
const isPass = t => t === 'HPQ' || t === 'LPQ';

/** A filter's biquad, normalised by a0 (the cookbook's Q form for every type). */
export function coefficients({ type, f, gain = 0, q }) {
    const A = Math.pow(10, gain / 40), w0 = 2 * Math.PI * f / FS, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'PK') {
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
    } else if (type === 'LSC' || type === 'HSC') {
        const s = 2 * Math.sqrt(A) * alpha, sign = type === 'LSC' ? 1 : -1;
        b0 = A * ((A + 1) - sign * (A - 1) * cos + s);
        b1 = sign * 2 * A * ((A - 1) - sign * (A + 1) * cos);
        b2 = A * ((A + 1) - sign * (A - 1) * cos - s);
        a0 = (A + 1) + sign * (A - 1) * cos + s;
        a1 = -sign * 2 * ((A - 1) + sign * (A + 1) * cos);
        a2 = (A + 1) + sign * (A - 1) * cos - s;
    } else if (type === 'LPQ') {
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else if (type === 'HPQ') {
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else {
        throw new Error(`Unknown filter type ${type}.`);
    }
    return { b: [b0 / a0, b1 / a0, b2 / a0], a: [1, a1 / a0, a2 / a0] };
}

/** |H| in dB at f. */
export function magnitudeDb(c, f) {
    const w = 2 * Math.PI * f / FS, c1 = Math.cos(w), c2 = Math.cos(2 * w), s1 = Math.sin(w), s2 = Math.sin(2 * w);
    const nr = c.b[0] + c.b[1] * c1 + c.b[2] * c2, ni = -(c.b[1] * s1 + c.b[2] * s2);
    const dr = 1 + c.a[1] * c1 + c.a[2] * c2, di = -(c.a[1] * s1 + c.a[2] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

export function filterResponse(filter, freqs) {
    const c = coefficients(filter);
    return freqs.map(f => magnitudeDb(c, f));
}

/** The sum of the filters that are on, in dB. */
export function eqResponse(filters, freqs) {
    const cs = filters.filter(x => x.on !== false).map(coefficients);
    return freqs.map(f => cs.reduce((s, c) => s + magnitudeDb(c, f), 0));
}

/** Minus the largest boost of the whole EQ over 20 Hz to 20 kHz, rounded up to 0.1 dB; 0 with none. */
export function preamp(filters) {
    const max = Math.max(0, ...eqResponse(filters, DENSE));
    return max > 0 ? -Math.ceil(max * 10 - 1e-9) / 10 : 0;
}

/** The RMS of measured + EQ - target over the bands from fMin to fMax that hold both. */
export function fitError(measured, target, filters, fMin = 20, fMax = 10000) {
    const idx = [];
    for (let i = 0; i < GRID.length; i++)
        if (GRID[i] >= fMin && GRID[i] <= fMax && Number.isFinite(measured[i]) && Number.isFinite(target[i])) idx.push(i);
    if (!idx.length) return NaN;
    const eq = eqResponse(filters, idx.map(i => GRID[i]));
    return Math.sqrt(idx.reduce((s, i, k) => s + (measured[i] + eq[k] - target[i]) ** 2, 0) / idx.length);
}

/** APO's config, which is also AutoEq's ParametricEQ.txt. channel adds a "Channel:" line. */
export function toApo(filters, { channel = null } = {}) {
    const lines = channel ? [`Channel: ${channel}`] : [];
    lines.push(`Preamp: ${preamp(filters).toFixed(1)} dB`);
    filters.forEach((x, i) => {
        const head = `Filter ${i + 1}: ${x.on === false ? 'OFF' : 'ON'} ${x.type} Fc ${Math.round(x.f)} Hz`;
        lines.push(isPass(x.type) ? `${head} Q ${x.q.toFixed(2)}` : `${head} Gain ${x.gain.toFixed(1)} dB Q ${x.q.toFixed(2)}`);
    });
    return lines.join('\n') + '\n';
}

const ALIAS = { PEQ: 'PK', LS: 'LSC', HS: 'HSC', LP: 'LPQ', HP: 'HPQ' };

/** APO or AutoEq text back into filters. Throws on a filter line it cannot read. */
export function fromApo(text) {
    const filters = [];
    let preampDb = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        const p = /^Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(line);
        if (p) { preampDb = Number(p[1]); continue; }
        if (!/^Filter\s*\d*\s*:/i.test(line)) continue;
        const m = /:\s*(ON|OFF)\s+(PK|PEQ|LSC|HSC|LPQ|HPQ|LS|HS|LP|HP)\b(.*)$/i.exec(line);
        if (!m) throw new Error(`"${line.slice(0, 50)}" is not a filter this app reads.`);
        const type = ALIAS[m[2].toUpperCase()] || m[2].toUpperCase();
        const num = re => { const v = re.exec(m[3]); return v ? Number(v[1]) : NaN; };
        const f = num(/Fc\s+(\d+(?:\.\d+)?)/i), gain = num(/Gain\s+(-?\d+(?:\.\d+)?)/i), q = num(/Q\s+(\d+(?:\.\d+)?)/i);
        if (!Number.isFinite(f)) throw new Error(`"${line.slice(0, 50)}" has no frequency.`);
        filters.push({ type, f, gain: Number.isFinite(gain) && !isPass(type) ? gain : 0,
                       q: Number.isFinite(q) ? q : (type === 'PK' ? 1 : 0.71), on: m[1].toUpperCase() === 'ON' });
    }
    if (!filters.length) throw new Error('No "Filter" lines found: this is not an APO or AutoEq EQ.');
    return { filters, preampDb };
}

/** AutoEq's GraphicEQ frequencies: 20 Hz times 1.0563 per step, whole hertz, 127 of them. */
export const GRAPHIC_EQ_FREQS = [...new Set(Array.from({ length: Math.ceil(Math.log(1000) / Math.log(1.0563)) },
                                                    (_, k) => Math.trunc(20 * Math.pow(1.0563, k))))];

/** Wavelet's GraphicEQ line, normalised as AutoEq does: its top 0.2 dB under zero. */
export function toGraphicEq(filters) {
    const r = eqResponse(filters, GRAPHIC_EQ_FREQS), top = Math.max(...r) + 0.2;
    return 'GraphicEQ: ' + GRAPHIC_EQ_FREQS.map((f, i) => `${f} ${(r[i] - top).toFixed(1)}`).join('; ') + '\n';
}

export function toCsv(filters) {
    return ['type,frequency,gain,q,on', ...filters.map(x =>
        [x.type, +x.f.toFixed(2), +x.gain.toFixed(2), +x.q.toFixed(3), x.on === false ? 0 : 1].join(','))].join('\n') + '\n';
}

export function fromCsv(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    lines.forEach((l, k) => {
        if (!l.trim() || /^type\s*,/i.test(l)) return;
        const [type, f, gain, q, on] = l.split(',').map(s => s.trim());
        const x = { type: (type || '').toUpperCase(), f: Number(f), gain: Number(gain), q: Number(q), on: on !== '0' };
        if (!TYPES.includes(x.type) || ![x.f, x.gain, x.q].every(Number.isFinite)) throw new Error(`CSV line ${k + 1} is not a filter: "${l}"`);
        out.push(x);
    });
    if (!out.length) throw new Error('The CSV holds no filters.');
    return out;
}

export const toJson = (filters, preampDb = preamp(filters)) =>
    JSON.stringify({ app: 'RndB Measure', preampDb, filters }, null, 1) + '\n';

export function fromJson(text) {
    let j;
    try { j = JSON.parse(text); } catch (err) { throw new Error(`That file is not JSON: ${err.message}`); }
    const list = Array.isArray(j) ? j : j && j.filters;
    if (!Array.isArray(list) || !list.length) throw new Error('That JSON holds no filters.');
    const filters = list.map((x, k) => {
        const type = String(x.type || '').toUpperCase();
        if (!TYPES.includes(type) || !Number.isFinite(+x.f) || !Number.isFinite(+x.q)) throw new Error(`Filter ${k + 1} in that JSON is not one this app reads.`);
        return { type, f: +x.f, gain: +x.gain || 0, q: +x.q, on: x.on !== false };
    });
    return { filters, preampDb: Number.isFinite(j.preampDb) ? j.preampDb : null };
}

/**
 * AutoEQ: peaking filters that bring measured to target, both on GRID with the target already
 * placed on the measurement. Each new filter goes where the remaining error (smoothed over a
 * sixth of an octave, so a narrow notch does not draw one) is largest, as wide as that error;
 * then every filter's frequency, gain and Q are refined in turn while the RMS error falls.
 * Limits always hold: a deep notch gets the most cut allowed, never more.
 */
export function autoEq(measured, target, opts = {}) {
    const o = { count: 10, maxBoost: 6, maxCut: 12, qMin: 0.5, qMax: 5, fMin: 20, fMax: 10000, ...opts };
    const idx = [];
    for (let i = 0; i < GRID.length; i++)
        if (GRID[i] >= o.fMin && GRID[i] <= o.fMax && Number.isFinite(measured[i]) && Number.isFinite(target[i])) idx.push(i);
    if (idx.length < 20) throw new Error('Too few bands hold both a measurement and a target to fit an EQ.');
    const fs = idx.map(i => GRID[i]), want = idx.map(i => target[i] - measured[i]);
    const clamp = x => ({ type: 'PK', on: true, f: Math.min(o.fMax, Math.max(o.fMin, x.f)),
                          gain: Math.min(o.maxBoost, Math.max(-o.maxCut, x.gain)), q: Math.min(o.qMax, Math.max(o.qMin, x.q)) });
    const respOf = x => { const c = coefficients(x); return fs.map(f => magnitudeDb(c, f)); };
    const rms = total => Math.sqrt(total.reduce((s, v, k) => s + (want[k] - v) ** 2, 0) / total.length);
    const filters = [], resp = [];
    let total = want.map(() => 0);

    for (let n = 0; n < o.count; n++) {
        const err = want.map((w, k) => w - total[k]);
        const sm = err.map((_, k) => {
            let s = 0, m = 0;
            for (let j = 0; j < fs.length; j++) if (Math.abs(Math.log2(fs[j] / fs[k])) <= 1 / 12) { s += err[j]; m++; }
            return s / m;
        });
        let k = 0;
        for (let j = 1; j < sm.length; j++) if (Math.abs(sm[j]) > Math.abs(sm[k])) k = j;
        if (Math.abs(sm[k]) < 0.5) break;
        let a = k, b = k;
        const half = Math.abs(sm[k]) / 2, sign = Math.sign(sm[k]);
        while (a > 0 && Math.sign(sm[a - 1]) === sign && Math.abs(sm[a - 1]) > half) a--;
        while (b < sm.length - 1 && Math.sign(sm[b + 1]) === sign && Math.abs(sm[b + 1]) > half) b++;
        const bw = Math.max(Math.log2(fs[b] / fs[a]), 1 / 6), r2 = Math.pow(2, bw);
        const x = clamp({ f: fs[k], gain: sm[k], q: Math.sqrt(r2) / (r2 - 1) });
        filters.push(x);
        resp.push(respOf(x));
        total = total.map((v, j) => v + resp[resp.length - 1][j]);
    }

    let step = { f: 1 / 6, g: 1, q: 0.25 }, cur = rms(total);     // octaves, dB, log2 of Q
    for (let pass = 0; pass < 80 && step.g > 0.02; pass++) {
        let better = false;
        for (let n = 0; n < filters.length; n++) {
            const x = filters[n];
            for (const t of [{ ...x, f: x.f * Math.pow(2, step.f) }, { ...x, f: x.f / Math.pow(2, step.f) },
                             { ...x, gain: x.gain + step.g }, { ...x, gain: x.gain - step.g },
                             { ...x, q: x.q * Math.pow(2, step.q) }, { ...x, q: x.q / Math.pow(2, step.q) }]) {
                const c = clamp(t), r = respOf(c), next = total.map((v, j) => v - resp[n][j] + r[j]), e = rms(next);
                if (e < cur - 1e-6) { filters[n] = c; resp[n] = r; total = next; cur = e; better = true; }
            }
        }
        if (!better) step = { f: step.f / 2, g: step.g / 2, q: step.q / 2 };
    }

    const out = filters.map(x => ({ type: 'PK', f: Math.round(x.f), gain: Math.round(x.gain * 10) / 10,
                                    q: Math.round(x.q * 100) / 100, on: true })).sort((p, q) => p.f - q.f);
    return { filters: out, rmsBefore: fitError(measured, target, [], o.fMin, o.fMax), rmsAfter: fitError(measured, target, out, o.fMin, o.fMax) };
}

/** One side EQ'd to the other's shape (met at 1 kHz), ±6 dB. levelDb: how much louder `other` is at 1 kHz. */
export function channelMatch(side, other, opts = {}) {
    const shift = valueAt(GRID, side, 1000) - valueAt(GRID, other, 1000);
    const s = Number.isFinite(shift) ? shift : 0;
    const r = autoEq(side, other.map(v => v + s), { maxBoost: 6, maxCut: 6, ...opts });
    return { ...r, levelDb: -s };
}
