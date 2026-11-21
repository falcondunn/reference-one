/**
 * RndB Measure - targets: Flat, the built-ins in data/targets.json (AutoEq's 711 targets, MIT,
 * made by hardware/reference_one_v4/app/make_app_targets.mjs), and the user's own files.
 */
import { GRID, onGrid, valueAt } from './curves.mjs?v=2026-11-01.3';
import { parseCurve } from './parse.mjs?v=2026-11-01.3';

export const FLAT = { id: 'flat', name: 'Flat', mags: GRID.map(() => 0), builtIn: true };

export async function loadBuiltIns(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const j = await res.json();
    return { targets: [FLAT, ...j.targets.map(t => ({ ...t, builtIn: true }))], license: j.license, source: j.source };
}

/** A target from a curve file: read like a curve, put on the grid, 0 dB at 1 kHz, named after the file. */
export function targetFromFile(fileName, text) {
    const name = fileName.replace(/\.[^.]+$/, '');
    const p = parseCurve(text), mags = onGrid(p.freqs, p.mags), ref = valueAt(GRID, mags, 1000);
    return { id: 'user-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target'),
             name, mags: mags.map(v => v - ref), builtIn: false };
}
