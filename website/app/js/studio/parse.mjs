/**
 * RndB Measure - curve files. Reading: our .txt and .csv, REW text exports, squiglink and PEQdB
 * CSVs, AutoEq CSVs. Writing: the .txt and .csv the old Graph tab wrote, unchanged.
 * No DOM, no audio (tests: hardware/reference_one_v4/tests/website_studio_parse.test.mjs).
 */
import { valueAt, isAbsolute } from './curves.mjs?v=2026-11-01.3';

const isNum = s => s !== undefined && s !== '' && Number.isFinite(Number(s));
const cells = line => (/[,;\t]/.test(line) ? line.split(/[,;\t]/) : line.split(/\s+/)).map(c => c.trim());

/**
 * A curve file as { freqs, mags, diag }. Comment lines (*, #, //) and one header row before the
 * numbers are skipped; the level is AutoEq's raw column when there is one, else the first column
 * a header names as a level, else the second. Our .csv's header carries its unit, so an absolute
 * curve comes back absolute; anything else is relative, 0 dB at 1 kHz. Throws an Error naming
 * the first line it cannot read: it never returns part of a file.
 */
export function parseCurve(text) {
    const lines = String(text).split(/\r?\n/);
    let header = null, col = 1;
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || /^(\*|#|\/\/)/.test(line)) continue;
        const c = cells(line);
        if (!isNum(c[0])) {
            if (header || rows.length) throw new Error(`Line ${i + 1} is not a frequency and a level: "${line.slice(0, 60)}"`);
            header = c;
            const raw = c.findIndex(h => /^raw$/i.test(h));
            const level = c.findIndex((h, k) => k > 0 && /spl|db|level|magnitude|amplitude/i.test(h));
            col = raw > 0 ? raw : level > 0 ? level : 1;
            continue;
        }
        if (!isNum(c[col])) throw new Error(`Line ${i + 1} is not a frequency and a level: "${line.slice(0, 60)}"`);
        rows.push([Number(c[0]), Number(c[col])]);
    }
    if (rows.length < 10) throw new Error(`Only ${rows.length} rows of numbers: a curve needs at least 10.`);
    rows.sort((a, b) => a[0] - b[0]);
    const freqs = rows.map(r => r[0]), mags = rows.map(r => r[1]);
    if (freqs[0] > 200 || freqs[freqs.length - 1] < 5000)
        throw new Error(`The file covers ${freqs[0]} to ${freqs[freqs.length - 1]} Hz: a curve needs 200 Hz to 5 kHz at least.`);
    const unit = (header || []).map(h => (/\(([^)]*dB[^)]*)\)/.exec(h) || [])[1]).find(Boolean) || '';
    if (/SPL/.test(unit)) return { freqs, mags, diag: { unit, normalizedAt: 0, calibrated: true, warnings: [] } };
    const re = /dB re (\d+(?:\.\d+)?) Hz/.exec(unit);
    const at = re ? Number(re[1]) : 1000;
    const ref = valueAt(freqs, mags, at);
    return { freqs, mags: mags.map(m => m - ref), diag: { unit: 'dB rel', normalizedAt: at, calibrated: false, warnings: [] } };
}

/**
 * The published curves' .txt, as the old Graph tab wrote it: 384 log-spaced points, no header,
 * a relative or raw curve at 75 dB at 1 kHz and an absolute one as measured. A gap is left out.
 */
export function exportTxt(freqs, mags, diag = {}) {
    const N = 384, F0 = 20, F1 = 20000, REF = 75;
    const at = hz => {                       // a gap beside a value takes the value, as before
        const n = freqs.length;
        if (hz <= freqs[0]) return mags[0];
        if (hz >= freqs[n - 1]) return mags[n - 1];
        let i = 0;
        while (i < n - 2 && freqs[i + 1] < hz) i++;
        const t = (hz - freqs[i]) / (freqs[i + 1] - freqs[i]), a = mags[i], b = mags[i + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : b;
        return a + t * (b - a);
    };
    const v1k = at(1000);
    const offset = isAbsolute(diag) ? 0 : REF - (Number.isFinite(v1k) ? v1k : 0);
    const lines = [];
    for (let i = 0; i < N; i++) {
        const hz = F0 * Math.pow(F1 / F0, i / (N - 1)), v = at(hz);
        if (Number.isFinite(v)) lines.push(hz.toFixed(2) + ' ' + (v + offset).toFixed(3));
    }
    return lines.join('\n') + '\n';
}

/** The CSV: the curve as measured on its own grid, its unit in the header, a gap left out. */
export function exportCsv(freqs, mags, diag = {}) {
    const unit = diag.normalizedAt ? `dB re ${diag.normalizedAt} Hz` : (diag.unit || 'dB');
    const rows = [`Frequency (Hz),Level (${unit})`];
    freqs.forEach((f, i) => { if (Number.isFinite(mags[i])) rows.push(f.toFixed(2) + ',' + mags[i].toFixed(3)); });
    return rows.join('\n') + '\n';
}

/** A file name from an entry's name, by the old app's rule: word characters, spaces, dots, dashes; 60 at most. */
export const fileName = (name, ext) =>
    ((name || 'RndB measurement').replace(/[^\w\s.-]/g, '').trim().slice(0, 60) || 'RndB measurement') + ext;
