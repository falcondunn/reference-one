/**
 * RndB Measure - the one graph, drawn the way the website draws its charts: canvas paper, the
 * mids band, a soft grid, muted labels, blue left and red right. The studio hands it a scene; it
 * draws it, reads the cursor out under Inspect, and lets the EQ's handles be dragged (frequency
 * and gain), scrolled (Q) or moved with the arrow keys once one is chosen.
 */
import { GRID } from './curves.mjs?v=2026-11-01.3';

const PAPER = '#faf9f5', BAND = '#f2ede4', LINE = '#ddd4c5', MUTED = '#6c6a64', INK = '#141413';
const FONT = '500 12.5px Inter, -apple-system, "Segoe UI", sans-serif';
const PAD = { left: 50, right: 14, top: 16, bottom: 30 };
const LABELS = [[20, '20 Hz'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1 kHz'],
                [2000, '2k'], [5000, '5k'], [10000, '10 kHz'], [20000, '20k']];
const NARROW = [[20, '20 Hz'], [100, '100'], [1000, '1 kHz'], [10000, '10k']];   // a phone's graph: none overlap
const MINOR = [30, 40, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000];

/** Pixel mapping for a w x h canvas, the axis running down `range` dB from `top`. */
export function axes(w, h, top, range) {
    const x0 = PAD.left, x1 = w - PAD.right, y0 = PAD.top, y1 = h - PAD.bottom;
    return {
        x0, x1, y0, y1,
        x: f => x0 + (x1 - x0) * Math.log10(f / 20) / 3,
        y: db => y0 + (y1 - y0) * (top - db) / range,
        f: px => 20 * Math.pow(1000, (px - x0) / (x1 - x0)),
        db: py => top - (py - y0) / (y1 - y0) * range,
    };
}

/** The runs of a curve to stroke: a gap lifts the pen, it is never bridged. */
export function runs(mags) {
    const out = [];
    let cur = null;
    mags.forEach((v, i) => {
        if (Number.isFinite(v)) (cur ??= []).push(i);
        else if (cur) { out.push(cur); cur = null; }
    });
    if (cur) out.push(cur);
    return out;
}

/** The GRID index nearest a frequency. */
export const nearest = f => Math.max(0, Math.min(GRID.length - 1, Math.round(Math.log(f / 20) / Math.log(1000) * (GRID.length - 1))));

const handleDb = (eq, x) => eq.baseline + (x.type === 'HPQ' || x.type === 'LPQ' ? 0 : x.gain);

export class Graph {
    constructor(canvas, { onHandle = () => {} } = {}) {
        Object.assign(this, { canvas, onHandle, scene: null, cursor: null, drag: -1, selected: -1 });
        canvas.addEventListener('pointermove', e => this._move(e));
        canvas.addEventListener('pointerleave', () => { this.cursor = null; this._paint(); });
        canvas.addEventListener('pointerdown', e => this._down(e));
        canvas.addEventListener('pointerup', () => { this.drag = -1; });
        canvas.addEventListener('pointercancel', () => { this.drag = -1; });
        canvas.addEventListener('wheel', e => this._wheel(e), { passive: false });
        canvas.addEventListener('keydown', e => this._key(e));
        new ResizeObserver(() => this._paint()).observe(canvas);
    }

    draw(scene) {
        this.scene = scene;
        // With handles out a touch drags them; otherwise it scrolls the page as usual.
        this.canvas.style.touchAction = scene.eq && scene.eq.handles ? 'none' : '';
        this._paint();
    }
    png() { return this.canvas.toDataURL('image/png'); }

    _ax() { const r = this.canvas.getBoundingClientRect(); return axes(r.width, r.height, this.scene.top, this.scene.range); }
    _hit(e) {
        const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        const eq = this.scene && this.scene.eq;
        let best = -1, d = 10;
        if (eq && eq.handles) {
            const ax = this._ax();
            eq.filters.forEach((x, i) => { const dd = Math.hypot(ax.x(x.f) - px, ax.y(handleDb(eq, x)) - py); if (dd < d) { d = dd; best = i; } });
        }
        return { i: best, px, py };
    }
    _move(e) {
        if (!this.scene) return;
        const { i, px, py } = this._hit(e);
        if (this.drag >= 0) {
            const ax = this._ax(), eq = this.scene.eq;
            this.onHandle(this.drag, { f: Math.min(20000, Math.max(20, ax.f(px))), gain: Math.min(24, Math.max(-24, ax.db(py) - eq.baseline)) });
            return;
        }
        this.canvas.style.cursor = i >= 0 ? 'grab' : 'default';
        this.cursor = this.scene.inspect ? px : null;
        this._paint();
    }
    _down(e) {
        const { i } = this._hit(e);
        if (i < 0) return;
        this.drag = i;
        this.selected = i;
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.focus();
        this._paint();
    }
    _wheel(e) {
        const { i } = this._hit(e);
        if (i < 0) return;
        e.preventDefault();
        const q = this.scene.eq.filters[i].q;
        this.onHandle(i, { q: e.deltaY < 0 ? q * 1.12 : q / 1.12 });
    }
    _key(e) {
        const filters = this.scene && this.scene.eq && this.scene.eq.handles ? this.scene.eq.filters : [];
        const k = e.key;
        if ((k === '[' || k === ']') && filters.length) {      // choose a filter without a pointer
            e.preventDefault();
            const step = k === ']' ? 1 : filters.length - 1;
            this.selected = this.selected < 0 || this.selected >= filters.length ? (k === ']' ? 0 : filters.length - 1) : (this.selected + step) % filters.length;
            this._paint();
            return;
        }
        const x = filters[this.selected];
        if (!x) return;
        let change = null;
        if (k === 'ArrowLeft' || k === 'ArrowRight')
            change = e.shiftKey ? { q: k === 'ArrowRight' ? x.q * 1.12 : x.q / 1.12 } : { f: x.f * Math.pow(2, (k === 'ArrowRight' ? 1 : -1) / 24) };
        else if (k === 'ArrowUp' || k === 'ArrowDown') change = { gain: x.gain + (k === 'ArrowUp' ? 0.5 : -0.5) };
        else if (k === 'Escape') { this.selected = -1; this._paint(); return; }
        if (!change) return;
        e.preventDefault();
        this.onHandle(this.selected, change);
    }

    _paint() {
        const c = this.canvas, r = c.getBoundingClientRect(), w = r.width, h = r.height;
        if (w < 1 || h < 1 || !this.scene) return;
        const dpr = window.devicePixelRatio || 1;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const g = c.getContext('2d'), s = this.scene, ax = axes(w, h, s.top, s.range);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, w, h);
        g.fillStyle = PAPER;
        g.fillRect(ax.x0, ax.y0, ax.x1 - ax.x0, ax.y1 - ax.y0);
        g.fillStyle = BAND;
        g.fillRect(ax.x(250), ax.y0, ax.x(4000) - ax.x(250), ax.y1 - ax.y0);
        const stepDb = s.range <= 30 ? 5 : 10, firstDb = Math.ceil((s.top - s.range) / stepDb) * stepDb;
        g.strokeStyle = LINE;
        g.lineWidth = 1;
        g.beginPath();
        for (const f of [...MINOR, ...LABELS.map(l => l[0])]) { const x = Math.round(ax.x(f)) + 0.5; g.moveTo(x, ax.y0); g.lineTo(x, ax.y1); }
        for (let db = firstDb; db <= s.top; db += stepDb) { const y = Math.round(ax.y(db)) + 0.5; g.moveTo(ax.x0, y); g.lineTo(ax.x1, y); }
        g.stroke();
        g.font = FONT;
        g.fillStyle = MUTED;
        const narrow = ax.x1 - ax.x0 < 420;
        for (const [f, t] of narrow ? NARROW : LABELS) {
            g.textAlign = f === 20 ? 'left' : f === 20000 ? 'right' : 'center';
            g.fillText(t, ax.x(f), h - 10);
        }
        g.textAlign = 'right';
        for (let db = firstDb; db <= s.top; db += stepDb) g.fillText(String(db), ax.x0 - 8, ax.y(db) + 4);
        g.textAlign = 'center';
        if (!narrow) for (const [f, t] of [[Math.sqrt(20 * 250), 'bass'], [1000, 'mids'], [Math.sqrt(4000 * 20000), 'treble']]) g.fillText(t, ax.x(f), ax.y0 + 16);
        g.textAlign = 'left';
        g.fillText(s.unit || 'dB', ax.x0 + 8, ax.y0 + 16);

        g.save();
        g.beginPath();
        g.rect(ax.x0, ax.y0, ax.x1 - ax.x0, ax.y1 - ax.y0);
        g.clip();
        if (s.eq && s.eq.showCurves) for (const x of s.eq.filters) this._trace(g, ax, x.response.map(v => v + s.eq.baseline), x.color, 1.5, null, 0.45);
        if (s.target) this._trace(g, ax, s.target.mags, MUTED, 2, [7, 6]);
        for (const cv of s.curves) this._trace(g, ax, cv.mags, cv.color, cv.width || 2.4, null, cv.alpha ?? 1);
        if (s.eq && s.eq.result) this._trace(g, ax, s.eq.result, INK, 2.6);
        if (s.eq && s.eq.handles) s.eq.filters.forEach((x, i) => {
            g.beginPath();
            g.arc(ax.x(x.f), ax.y(handleDb(s.eq, x)), i === this.selected ? 8 : 6.5, 0, 2 * Math.PI);
            g.fillStyle = x.color;
            g.fill();
            g.lineWidth = 2;
            g.strokeStyle = '#fff';
            g.stroke();
        });
        g.restore();

        g.font = '500 13px Inter, -apple-system, "Segoe UI", sans-serif';
        g.textAlign = 'left';
        const legend = s.legend || [];
        legend.forEach((l, i) => { g.fillStyle = l.color; g.fillText(l.label, ax.x0 + 14, ax.y1 - 14 - (legend.length - 1 - i) * 18); });
        if (this.cursor !== null && this.cursor >= ax.x0 && this.cursor <= ax.x1) this._readout(g, ax, w);
    }

    _trace(g, ax, mags, color, width, dash, alpha = 1) {
        g.save();
        g.globalAlpha = alpha;
        g.strokeStyle = color;
        g.lineWidth = width;
        g.lineJoin = 'round';
        g.lineCap = 'round';
        g.setLineDash(dash || []);
        for (const run of runs(mags)) {
            g.beginPath();
            run.forEach((i, k) => { const x = ax.x(GRID[i]), y = ax.y(mags[i]); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
            g.stroke();
        }
        g.restore();
    }

    _readout(g, ax, w) {
        const i = nearest(ax.f(this.cursor)), x = ax.x(GRID[i]), f = GRID[i];
        const head = f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
        const rows = (this.scene.readout || []).map(r => ({ color: r.color,
            text: `${r.label} ${Number.isFinite(r.mags[i]) ? (r.mags[i] < 0 ? '−' : '') + Math.abs(r.mags[i]).toFixed(1) + ' dB' : 'no value'}` }));
        g.save();
        g.strokeStyle = 'rgba(20, 20, 19, 0.35)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(Math.round(x) + 0.5, ax.y0);
        g.lineTo(Math.round(x) + 0.5, ax.y1);
        g.stroke();
        g.font = FONT;
        const bw = Math.max(g.measureText(head).width, ...rows.map(r => g.measureText(r.text).width)) + 24, bh = 26 + rows.length * 18;
        const bx = x + 12 + bw > w - 4 ? x - 12 - bw : x + 12, by = ax.y0 + (ax.y1 - ax.y0) * 0.55;
        g.fillStyle = '#fff';
        g.strokeStyle = '#e3dccf';
        g.beginPath();
        g.roundRect(bx, by, bw, bh, 6);
        g.fill();
        g.stroke();
        g.textAlign = 'left';
        g.fillStyle = INK;
        g.fillText(head, bx + 12, by + 18);
        rows.forEach((r, k) => { g.fillStyle = r.color; g.fillText(r.text, bx + 12, by + 36 + k * 18); });
        g.restore();
    }
}
