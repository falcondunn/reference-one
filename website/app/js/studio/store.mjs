/**
 * RndB Measure - the measurement list: REW's measurements panel, one entry per earphone. An
 * entry holds L and R captures (and unsided ones: imported curves, old History items); each
 * side's curve is the RMS average of its captures. Saved in the browser, and as session files.
 * No DOM, no audio (tests: hardware/reference_one_v4/tests/website_studio_store.test.mjs).
 */
import { GRID, onGrid, rmsAverage, kindOf } from './curves.mjs?v=2026-11-01.3';

/** Each entry's L and R inks, every one 3:1 or more on the canvas. The first pair is the website's. */
export const INKS = [['#2350a0', '#b8382c'], ['#2b6e43', '#4a8a5f'], ['#6b4fa0', '#8467b4'], ['#8a5d0c', '#a5741f'],
                     ['#1f6f78', '#3a8790'], ['#a03a72', '#b65488'], ['#4a5568', '#66718a'], ['#7a4a2a', '#946140']];
export const STORE_KEY = 'rndb-studio', HISTORY_KEY = 'rndb-history';

let seq = 0;
const newId = p => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const emptyEq = () => ({ L: [], R: [], avg: [] });
// JSON has no NaN: a gap is written as null, and must come back as a gap.
const revive = c => ({ ...c, mags: (c.mags || []).map(v => (v === null ? NaN : v)) });

export class Store {
    constructor(storage) {
        this.storage = storage;
        this.state = {
            version: 1, entries: [], targets: [],
            ui: { selected: null, target: 'harman-ie-2019', normalizeHz: 1000, smoothing: 12, rangeDb: 50, inspect: false },
        };
    }

    /** Reads the saved state; on a first start, brings the old History in as entries. */
    load() {
        let saved = null;
        try { saved = JSON.parse(this.storage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
        if (saved && saved.version === 1 && Array.isArray(saved.entries)) {
            for (const e of saved.entries) {
                e.captures = (e.captures || []).map(revive);
                e.eq = { ...emptyEq(), ...(e.eq || {}) };
                e.sides = { L: true, R: true, ...(e.sides || {}) };
            }
            this.state = { ...this.state, ...saved, targets: (saved.targets || []).map(revive),
                           ui: { ...this.state.ui, ...(saved.ui || {}) } };
            return this;
        }
        let old = [];
        try { old = JSON.parse(this.storage.getItem(HISTORY_KEY) || '[]'); } catch { old = []; }
        for (const h of Array.isArray(old) ? old : []) {
            if (!h || !h.fr || !Array.isArray(h.fr.freqs) || !Array.isArray(h.fr.magnitudes)) continue;
            const e = this.addEntry(h.label || 'Saved measurement');
            this.addCapture(e.id, null, h.fr, h.timestamp || new Date().toISOString());
        }
        this.state.entries.forEach((e, i) => { e.show = i === this.state.entries.length - 1; });
        return this;
    }

    /** Saves; false when the browser's storage is full, so the page can say so. */
    save() {
        try { this.storage.setItem(STORE_KEY, JSON.stringify(this.state)); return true; } catch { return false; }
    }

    entry(id) { return this.state.entries.find(e => e.id === id) || null; }

    addEntry(name) {
        const used = new Set(this.state.entries.map(e => e.color));
        let color = INKS.findIndex((_, i) => !used.has(i));
        if (color < 0) color = this.state.entries.length % INKS.length;
        const e = { id: newId('e'), name: name || 'New earphone', color, offsetDb: 0, show: true,
                    sides: { L: true, R: true }, captures: [], eq: emptyEq() };
        this.state.entries.push(e);
        return e;
    }

    /**
     * Adds a measured curve (analysis.js's { freqs, magnitudes, diagnostics }) to an entry, on the
     * app's grid. Refuses a curve of another kind than the entry holds: one entry is one earphone
     * on one scale, and averaging a relative curve into dB SPL/V would mean nothing.
     */
    addCapture(entryId, side, fr, at = new Date().toISOString()) {
        const e = this.entry(entryId);
        if (!e) throw new Error('That entry no longer exists.');
        const diag = { ...(fr.diagnostics || {}) };
        const kind = kindOf(diag), held = e.captures.length ? kindOf(e.captures[0].diag) : kind;
        if (held !== kind) throw new Error(`${e.name} holds ${held} curves; this one is ${kind}. Measure it into a new entry.`);
        const c = { id: newId('c'), side: side || null, at, mags: onGrid(fr.freqs, fr.magnitudes), diag };
        e.captures.push(c);
        return c;
    }

    removeCapture(entryId, captureId) {
        const e = this.entry(entryId);
        if (e) e.captures = e.captures.filter(c => c.id !== captureId);
    }
    removeEntry(id) { this.state.entries = this.state.entries.filter(e => e.id !== id); }
    rename(id, name) { const e = this.entry(id); if (e && name) e.name = name; }

    /** A side's curve, the RMS average of its captures; side is 'L', 'R' or null (unsided). */
    sideCurve(e, side) {
        const cs = e.captures.filter(c => c.side === side);
        if (!cs.length) return null;
        return { mags: rmsAverage(cs.map(c => c.mags)), diag: cs[0].diag, count: cs.length };
    }

    /** The curve the EQ works on: 'L', 'R', or 'avg', both sides averaged, else the one there is. */
    eqCurve(e, which) {
        if (which === 'L' || which === 'R') return this.sideCurve(e, which);
        const L = this.sideCurve(e, 'L'), R = this.sideCurve(e, 'R');
        if (L && R) return { mags: rmsAverage([L.mags, R.mags]), diag: L.diag };
        return L || R || this.sideCurve(e, null);
    }

    /** Entries of one kind, RMS-averaged side by side into a new entry. */
    average(entries) {
        if (entries.length < 2) throw new Error('Show at least two entries to average them.');
        const kinds = new Set(entries.flatMap(e => e.captures.map(c => kindOf(c.diag))));
        if (kinds.size > 1) throw new Error(`These entries are on different scales (${[...kinds].join(', ')}): they cannot be averaged.`);
        const out = this.addEntry(`Average of ${entries.length}`);
        for (const side of ['L', 'R', null]) {
            const curves = entries.map(e => this.sideCurve(e, side)).filter(Boolean);
            if (curves.length) out.captures.push({ id: newId('c'), side, at: new Date().toISOString(),
                mags: rmsAverage(curves.map(c => c.mags)), diag: { ...curves[0].diag, averageOf: curves.length } });
        }
        return out;
    }

    exportSession() { return JSON.stringify({ ...this.state, exported: new Date().toISOString() }) + '\n'; }

    /** Adds a session file's entries and targets. A damaged file adds nothing. Returns how many entries. */
    importSession(text) {
        let s;
        try { s = JSON.parse(text); } catch (err) { throw new Error(`That file is not an RndB session: ${err.message}`); }
        if (!s || s.version !== 1 || !Array.isArray(s.entries)) throw new Error('That file is not an RndB session (version 1).');
        for (const e of s.entries)
            if (!e || !Array.isArray(e.captures) || !e.captures.every(c => Array.isArray(c.mags) && c.mags.length === GRID.length))
                throw new Error(`Entry "${e && e.name}" is not on this app's grid: the file is damaged or from another app.`);
        for (const e of s.entries) {
            const n = this.addEntry(e.name);
            Object.assign(n, { offsetDb: Number(e.offsetDb) || 0, show: e.show !== false,
                               sides: { L: true, R: true, ...(e.sides || {}) }, eq: { ...emptyEq(), ...(e.eq || {}) } });
            n.captures = e.captures.map(c => ({ ...revive(c), id: newId('c') }));
        }
        for (const t of s.targets || [])
            if (Array.isArray(t.mags) && !this.state.targets.some(x => x.id === t.id)) this.state.targets.push(revive(t));
        return s.entries.length;
    }
}
