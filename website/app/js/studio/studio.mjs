/**
 * RndB Measure - the studio: REW's measurement list and EQ window, in the website's look.
 * It is the DOM around store.mjs (entries), graph.mjs (the one graph), peq.mjs (the EQ) and
 * targets.mjs. It plays nothing: Measure L and R call app.measure(), whose guards (the V4's
 * -20 dBFS cap, the no-earphone tick, the Rev 3 checks) live in the code that plays.
 * Spec: docs/superpowers/specs/2026-11-01-measurement-studio-design.md
 */
import { GRID, placement, targetShift, lrDifference, axisTop, kindOf } from './curves.mjs?v=2026-11-01.3';
import { parseCurve, exportTxt, exportCsv, fileName } from './parse.mjs?v=2026-11-01.3';
import { Store, INKS } from './store.mjs?v=2026-11-01.3';
import { eqResponse, filterResponse, preamp, autoEq, channelMatch, fitError, toApo, fromApo, toGraphicEq,
         toCsv, fromCsv, toJson, fromJson } from './peq.mjs?v=2026-11-01.3';
import { FLAT, loadBuiltIns, targetFromFile } from './targets.mjs?v=2026-11-01.3';
import { Graph } from './graph.mjs?v=2026-11-01.3';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FILTER_INKS = ['#2350a0', '#b8382c', '#2b6e43', '#6b4fa0', '#8a5d0c', '#1f6f78', '#a03a72', '#4a5568', '#7a4a2a', '#3a8790'];
const TYPE_NAME = { PK: 'Peak', LSC: 'Low shelf', HSC: 'High shelf', HPQ: 'High pass', LPQ: 'Low pass' };
const hz = f => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
const nb = s => String(s).replace(/(\d) /g, '$1 ');      // on screen a number keeps its unit: "10 kHz" never breaks
const unitLabel = d => (d.normalizedAt ? `dB re ${hz(d.normalizedAt)}` : (d.unit || 'dB'));

function download(name, text, type = 'text/plain') {
    const a = document.createElement('a');
    a.download = name;
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

class Studio {
    constructor(app) {
        this.app = app;
        this.store = new Store(window.localStorage).load();
        this.ui = this.store.state.ui;
        this.targets = [FLAT, ...this.store.state.targets];
        this.tab = 'list';
        this.bypass = false;
        this.showFilterCurves = true;
        this.lastSide = 'L';
        this.measuring = false;
        this.captureNote = '';
        this.captureRefused = false;
        this.saveTimer = 0;
        this.graph = new Graph($('frCanvas'), { onHandle: (i, change) => this._moveFilter(i, change) });
        app.onCapture = (side, fr) => this._capture(side, fr);
        app.onProgress = pct => this.status(`Measuring ${this.lastSide}: ${Math.round(pct)} %`);
        Object.defineProperty(app, 'entryName', { configurable: true, get: () => this._selected()?.name || '' });
        this._bind();
        this.render();
        loadBuiltIns('data/targets.json?v=2026-11-01.3')
            .then(({ targets, license }) => {
                this.targets = [...targets, ...this.store.state.targets];
                $('licenseText').textContent = license;
                this.render();
            })
            .catch(err => this.status(`The built-in targets did not load (${err.message}). Flat and your imported targets still work; reload the page to try again.`, 'error'));
    }

    // ---- state ---------------------------------------------------------------------------------
    _selected() { return this.store.entry(this.ui.selected); }
    _target() { return this.targets.find(t => t.id === this.ui.target) || FLAT; }
    _shown() { return this.store.state.entries.filter(e => e.show); }
    _smooth(mags, n = this.ui.smoothing) { return n ? window.analysis.smooth(GRID, mags, n) : mags; }
    _eqPick() {
        const [id, which] = ($('eqCurveSelect').value || '').split('|');
        const entry = this.store.entry(id);
        return entry ? { entry, which } : { entry: null, which: null };
    }
    _filters() { const { entry, which } = this._eqPick(); return entry ? entry.eq[which] : null; }
    _whichLabel(e, which) {
        if (which === 'L' || which === 'R') return which;
        return this.store.sideCurve(e, 'L') && this.store.sideCurve(e, 'R') ? 'L and R average' : 'curve';
    }
    _advanced() {
        return { count: Number($('aeCount').value), maxBoost: Number($('aeBoost').value), maxCut: Number($('aeCut').value),
                 qMin: 0.5, qMax: Number($('aeQ').value), fMin: 20, fMax: Number($('aeRange').value) };
    }

    save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            if (!this.store.save()) this.status('Your browser’s storage is full: export the session, then delete entries you no longer need.', 'error');
        }, 300);
    }
    status(text, kind = '') {
        const el = $('studioStatus');
        el.textContent = nb(text);
        el.className = 'status' + (kind ? ` status--${kind}` : '');
    }

    // ---- wiring --------------------------------------------------------------------------------
    _bind() {
        document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => this._tab(b.dataset.tab)));
        $('measureLBtn').addEventListener('click', () => this._measure('L'));
        $('measureRBtn').addEventListener('click', () => this._measure('R'));
        $('smoothingSelect').addEventListener('change', e => { this.ui.smoothing = Number(e.target.value); this.save(); this.draw(); });
        $('rangeSelect').addEventListener('change', e => { this.ui.rangeDb = Number(e.target.value); this.save(); this.draw(); });
        $('normalizeSelect').addEventListener('change', e => { this.ui.normalizeHz = Number(e.target.value); this.save(); this.render(); });
        $('inspectBtn').addEventListener('click', () => { this.ui.inspect = !this.ui.inspect; this.save(); this.render(); });
        $('averageBtn').addEventListener('click', () => this._average());
        $('hideAllBtn').addEventListener('click', () => { for (const e of this.store.state.entries) e.show = false; this.save(); this.render(); });
        $('recolourBtn').addEventListener('click', () => {      // the inks again, in list order: the first entry blue and red
            this.store.state.entries.forEach((e, i) => { e.color = i % INKS.length; });
            this.save();
            this.render();
        });
        $('exportCsvBtn').addEventListener('click', () => this._exportShown());
        $('exportPngBtn').addEventListener('click', () => this._exportPng());
        $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
        $('searchInput').addEventListener('input', () => this.renderList());
        $('entryList').addEventListener('click', e => {
            const pick = e.target.closest('[data-pick]'), show = e.target.closest('[data-show]');
            if (pick) { this.ui.selected = pick.dataset.pick; this.save(); this.render(); }
            if (show) { const en = this.store.entry(show.dataset.show); en.show = !en.show; this.save(); this.render(); }
        });
        $('newEntryBtn').addEventListener('click', () => {      // the next sweeps go to a new earphone, named on its card
            const e = this.store.addEntry('New earphone');
            this.ui.selected = e.id;
            this.save();
            this.render();
            document.querySelector(`[data-rename="${e.id}"]`)?.select();
        });
        $('cards').addEventListener('change', e => this._cardChange(e));
        $('cards').addEventListener('click', e => this._cardClick(e));
        $('targetChips').addEventListener('click', e => {
            const t = e.target.closest('[data-target]');
            if (t) { this.ui.target = t.dataset.target; this.save(); this.render(); }
            if (e.target.closest('#importTargetBtn')) $('targetFile').click();
        });
        $('importCurveBtn').addEventListener('click', () => $('curveFile').click());
        $('curveFile').addEventListener('change', e => { this._importCurves([...e.target.files]); e.target.value = ''; });
        $('targetFile').addEventListener('change', e => { this._importTarget(e.target.files[0]); e.target.value = ''; });
        $('exportSessionBtn').addEventListener('click', () =>
            download(`RndB session ${new Date().toISOString().slice(0, 10)}.json`, this.store.exportSession(), 'application/json'));
        $('importSessionBtn').addEventListener('click', () => $('sessionFile').click());
        $('sessionFile').addEventListener('change', e => { this._importSession(e.target.files[0]); e.target.value = ''; });

        $('eqCurveSelect').addEventListener('change', () => { this.renderEq(); this.draw(); });
        $('autoEqBtn').addEventListener('click', () => this._autoEq());
        $('addFilterBtn').addEventListener('click', () => {
            const f = this._filters();
            if (!f) return this.status('Pick a curve to EQ first.', 'error');
            f.push({ type: 'PK', f: 1000, gain: 0, q: 1, on: true });
            this._eqChanged(true);
        });
        $('channelMatchBtn').addEventListener('click', () => this._channelMatch());
        $('bypassBtn').addEventListener('click', () => { this.bypass = !this.bypass; $('bypassBtn').setAttribute('aria-pressed', String(this.bypass)); this._eqChanged(false); });
        $('filterCurvesBtn').addEventListener('click', () => {
            this.showFilterCurves = !this.showFilterCurves;
            $('filterCurvesBtn').setAttribute('aria-pressed', String(this.showFilterCurves));
            this.draw();
        });
        $('sortBtn').addEventListener('click', () => { const f = this._filters(); if (f) { f.sort((a, b) => a.f - b.f); this._eqChanged(true); } });
        $('clearBtn').addEventListener('click', () => {
            const f = this._filters();
            if (f && f.length && confirm(`Clear all ${f.length} filters?`)) { f.length = 0; this._eqChanged(true); }
        });
        for (const type of ['input', 'change', 'click']) $('filterList').addEventListener(type, e => this._filterInput(e));
        for (const id of ['aeCount', 'aeBoost', 'aeCut', 'aeQ', 'aeRange']) $(id).addEventListener('change', () => this.renderEqNumbers());
        $('copyApoBtn').addEventListener('click', () => this._copyApo());
        $('graphicEqBtn').addEventListener('click', () => this._downloadEq('graphic'));
        $('eqCsvBtn').addEventListener('click', () => this._downloadEq('csv'));
        $('eqJsonBtn').addEventListener('click', () => this._downloadEq('json'));
        $('importEqBtn').addEventListener('click', () => $('eqFile').click());
        $('eqFile').addEventListener('change', e => { this._importEq(e.target.files[0]); e.target.value = ''; });
        $('pasteApoBtn').addEventListener('click', () => { $('pasteStatus').textContent = ''; $('pasteDialog').showModal(); });
        $('pasteCancelBtn').addEventListener('click', () => $('pasteDialog').close());
        $('pasteApplyBtn').addEventListener('click', () => this._pasteApo());
        // A menu closes once an item is chosen, on a click outside it, and on Escape.
        document.addEventListener('click', e => {
            const menu = e.target.closest('details.menu');
            this._closeMenus(menu && !e.target.closest('.menu__list button') ? menu : null);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') this._closeMenus(null); this._key(e); });
        addEventListener('pagehide', () => { clearTimeout(this.saveTimer); this.store.save(); });   // a change made just before leaving
    }

    _closeMenus(keep) { document.querySelectorAll('details.menu[open]').forEach(d => { if (d !== keep) d.open = false; }); }

    _key(e) {
        if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, select, textarea, dialog')) return;
        if (e.key === ' ' && !e.target.closest('button, a, summary, canvas')) { e.preventDefault(); this._measure(this.lastSide); }
        else if (e.key === '1') this._tab('list');
        else if (e.key === '2') this._tab('eq');
        else if (e.key === '3') this._tab('rig');
        else if (e.key === '?') $('helpDialog').showModal();
    }

    _tab(name) {
        this.tab = name;
        document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
        document.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== name; });
        document.querySelectorAll('[data-foot]').forEach(p => { p.hidden = p.dataset.foot !== name; });
        if (name === 'eq') this.renderEq();
        this.draw();
    }

    // ---- measuring -----------------------------------------------------------------------------
    async _measure(side) {
        if (this.measuring) return;
        this.measuring = true;
        this.lastSide = side;
        this.captureNote = '';
        this.captureRefused = false;
        this.status(`Measuring ${side}…`);
        let r;
        try { r = await this.app.measure(side); } catch (err) { r = { ok: false, message: `Measuring ${side} failed: ${err.message}` }; }
        this.measuring = false;
        if (!r) return;
        const text = [this.captureNote, r.message].filter(Boolean).join(' ');
        this.status(text, r.ok && !this.captureRefused ? 'ok' : 'error');
        if (!r.ok && !this.captureNote && (!this.app.engine.isConnected || /no earphone|Rig tab|Check/i.test(r.message))) this._tab('rig');
    }

    _capture(side, fr) {
        let e = this._selected();
        if (!e) { e = this.store.addEntry('New earphone'); this.ui.selected = e.id; }
        // A sweep of another kind than the entry holds is refused; _measure keeps that on screen.
        try { this.store.addCapture(e.id, side, fr); } catch (err) {
            this.captureNote = err.message;
            this.captureRefused = true;
            this.status(err.message, 'error');
            return;
        }
        e.show = true;
        e.sides[side] = true;
        const n = e.captures.filter(c => c.side === side).length;
        this.captureNote = `Added to ${e.name}, ${side}: ${n} sweep${n === 1 ? '' : 's'} on that side.`;
        this.save();
        this.render();
    }

    // ---- drawing -------------------------------------------------------------------------------
    render() {
        if (!this._selected()) this.ui.selected = this.store.state.entries[0]?.id ?? null;
        $('entryTitle').textContent = this._selected()?.name || 'Measure';
        $('smoothingSelect').value = String(this.ui.smoothing);
        $('rangeSelect').value = String(this.ui.rangeDb);
        $('normalizeSelect').value = String(this.ui.normalizeHz);
        $('inspectBtn').setAttribute('aria-pressed', String(!!this.ui.inspect));
        this.renderList();
        this.renderCards();
        this.renderChips();
        if (this.tab === 'eq') this.renderEq();
        this.draw();
    }

    renderList() {
        const q = $('searchInput').value.trim().toLowerCase();
        const all = this.store.state.entries;
        $('listEmpty').hidden = all.length > 0;
        $('entryList').innerHTML = all.filter(e => !q || e.name.toLowerCase().includes(q)).map(e => {
            const [ink, inkR] = INKS[e.color];
            const n = s => e.captures.filter(c => c.side === s).length;
            const meta = [n('L') && `L ${n('L')}`, n('R') && `R ${n('R')}`, n(null) && 'curve',
                          e.captures[0] && kindOf(e.captures[0].diag)].filter(Boolean).join(' · ') || 'No sweeps yet';
            return `<li class="item" aria-current="${e.id === this.ui.selected}">
              <button class="item__pick" type="button" data-pick="${e.id}"><span class="swatch" aria-hidden="true"><i style="background:${ink}"></i><i style="background:${inkR}"></i></span>
                <span><span class="item__name">${esc(e.name)}</span><span class="item__meta">${esc(meta)}</span></span></button>
              <button class="btn btn--quiet item__show" type="button" data-show="${e.id}" aria-pressed="${e.show}">${e.show ? 'Shown' : 'Hidden'}<span class="visually-hidden"> on the graph: ${esc(e.name)}</span></button></li>`;
        }).join('');
    }

    renderCards() {
        const cards = this._shown().map(e => {
            const [ink, inkR] = INKS[e.color];
            const L = this.store.sideCurve(e, 'L'), R = this.store.sideCurve(e, 'R');
            const d = L && R ? lrDifference(L.mags, R.mags) : null;
            const last = e.captures[e.captures.length - 1], dg = last ? last.diag : {};
            const valid = [Number.isFinite(dg.snrDb) && `S/N ${dg.snrDb.toFixed(0)} dB`, Number.isFinite(dg.latencyMs) && `latency ${dg.latencyMs.toFixed(0)} ms`].filter(Boolean).join(' · ');
            const side = (s, color, c) => (c ? `<label class="toggle"><input type="checkbox" data-side="${e.id}|${s}" ${e.sides[s] ? 'checked' : ''}><span class="swatch" aria-hidden="true"><i style="background:${color}"></i></span>${s}</label>` : '');
            const counts = [L && `L ${L.count}`, R && `R ${R.count}`].filter(Boolean).join(', ');
            return `<div class="panel card">
              <div class="card__head"><input class="card__name" value="${esc(e.name)}" data-rename="${e.id}" aria-label="Earphone name" autocomplete="off" spellcheck="false">
                <details class="menu"><summary class="btn btn--quiet">Export</summary><div class="menu__list">
                  <button type="button" data-export="${e.id}|txt">Curves (.txt, 75 dB at 1 kHz)</button>
                  <button type="button" data-export="${e.id}|csv">Curves as measured (.csv)</button>
                  <button type="button" data-delete="${e.id}">Delete ${esc(e.name)}</button></div></details></div>
              <div class="card__row">${side('L', ink, L)}${side('R', inkR, R)}<label>Offset <input class="field offset num" type="number" step="0.5" value="${e.offsetDb || 0}" data-offset="${e.id}" aria-label="Offset for ${esc(e.name)}"> dB</label></div>
              <div class="card__row">${counts ? `<span>Sweeps: ${counts}</span>` : ''}${d ? `<span>L and R within <b class="num">${d.max.toFixed(1)} dB</b> to 10 kHz</span>` : ''}</div>
              ${valid || (dg.warnings || []).length ? `<div class="card__row">${valid ? `<span>Last sweep: ${esc(nb(valid))}</span>` : ''}${(dg.warnings || []).length ? `<span class="warn">${esc(dg.warnings.join(' '))}</span>` : ''}</div>` : ''}
              <details class="sweeps"><summary>${e.captures.length} sweep${e.captures.length === 1 ? '' : 's'}</summary><ol>${e.captures.map(c =>
                `<li><span>${c.side || 'Curve'} · ${esc(new Date(c.at).toLocaleString())}</span><button class="btn btn--quiet" type="button" data-remove="${e.id}|${c.id}">Remove</button></li>`).join('')}</ol></details>
            </div>`;
        });
        const t = this._target();
        const credit = t.id === 'flat' ? '' : t.builtIn ? '<span class="note">AutoEq, MIT</span>' : `<button class="btn btn--quiet" type="button" data-untarget="${esc(t.id)}">Remove</button>`;
        cards.push(`<div class="panel card"><div class="card__head"><strong>${esc(t.name)}</strong>${credit}</div>
          <div class="card__row"><span class="toggle"><span class="swatch" aria-hidden="true"><i style="background:none;border:2px dashed #6c6a64"></i></span>Target</span>
          <span>Meets the curves at ${nb(this.ui.normalizeHz ? hz(this.ui.normalizeHz) : '1 kHz')}</span></div></div>`);
        $('cards').innerHTML = cards.join('');
    }

    renderChips() {
        $('targetChips').innerHTML = '<span class="label">Target</span>' + this.targets.map(t =>
            `<button class="btn" type="button" data-target="${esc(t.id)}" aria-pressed="${t.id === this.ui.target}">${esc(t.name)}</button>`).join('') +
            '<button class="btn btn--quiet" type="button" id="importTargetBtn">Import target</button>';
    }

    renderEq() {
        const sel = $('eqCurveSelect'), prev = sel.value, opts = [];
        for (const e of this.store.state.entries) {
            const hasL = !!this.store.sideCurve(e, 'L'), hasR = !!this.store.sideCurve(e, 'R');
            if (hasL && hasR) opts.push([`${e.id}|avg`, `${e.name} · L and R average`]);
            if (hasL) opts.push([`${e.id}|L`, `${e.name} · L`]);
            if (hasR) opts.push([`${e.id}|R`, `${e.name} · R`]);
            if (!hasL && !hasR && this.store.sideCurve(e, null)) opts.push([`${e.id}|avg`, e.name]);
        }
        sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('') || '<option value="">No curves yet</option>';
        const keep = opts.find(o => o[0] === prev) || opts.find(o => o[0].startsWith(`${this.ui.selected}|`)) || opts[0];
        if (keep) sel.value = keep[0];
        const { entry, which } = this._eqPick();
        const filters = entry ? entry.eq[which] : [];
        $('eqEmpty').hidden = filters.length > 0;
        $('filterList').innerHTML = filters.map((x, i) => `<div class="filter" data-filter="${i}">
          <span class="filter__dot" style="background:${FILTER_INKS[i % FILTER_INKS.length]}" aria-hidden="true"></span>
          <div class="filter__head"><select class="field" data-k="type" aria-label="Filter ${i + 1} type">${Object.keys(TYPE_NAME).map(t =>
              `<option value="${t}" ${t === x.type ? 'selected' : ''}>${i + 1} · ${TYPE_NAME[t]}</option>`).join('')}</select>
            <span class="row"><label class="toggle"><input type="checkbox" data-k="on" ${x.on !== false ? 'checked' : ''}>On</label>
            <button class="filter__x" type="button" data-k="delete" aria-label="Delete filter ${i + 1}">✕</button></span></div>
          <label class="label">Hz<input class="field num" type="number" min="20" max="20000" step="1" value="${Math.round(x.f)}" data-k="f"></label>
          <label class="label">dB<input class="field num" type="number" min="-24" max="24" step="0.1" value="${x.gain.toFixed(1)}" data-k="gain" ${x.type === 'HPQ' || x.type === 'LPQ' ? 'disabled' : ''}></label>
          <label class="label">Q<input class="field num" type="number" min="0.1" max="20" step="0.01" value="${x.q.toFixed(2)}" data-k="q"></label></div>`).join('');
        const other = which === 'L' ? 'R' : which === 'R' ? 'L' : null;
        $('channelMatchBtn').hidden = !(entry && other && this.store.sideCurve(entry, other));
        if (other) $('channelMatchBtn').textContent = `Match to ${other}`;
        this.renderEqNumbers();
    }

    renderEqNumbers() {
        const { entry, which } = this._eqPick();
        const filters = entry ? entry.eq[which] : [];
        $('preampOut').textContent = `${preamp(filters).toFixed(1)} dB`;
        const src = entry && this.store.eqCurve(entry, which);
        if (!src) { $('eqErrorOut').textContent = '–'; return; }
        const m = this._smooth(src.mags, 12), t = this._target(), fMax = Number($('aeRange').value);
        const tm = t.mags.map(v => v + targetShift(m, t.mags, this.ui.normalizeHz));
        $('eqErrorLabel').textContent = `RMS error to ${t.name}, to ${nb(hz(fMax))}`;
        $('eqErrorOut').textContent = `${fitError(m, tm, [], 20, fMax).toFixed(1)} → ${fitError(m, tm, this.bypass ? [] : filters, 20, fMax).toFixed(1)} dB`;
    }

    draw() {
        let list = [], src = null, pick = { entry: null };
        if (this.tab === 'eq') {
            pick = this._eqPick();
            const c = pick.entry && this.store.eqCurve(pick.entry, pick.which);
            if (c) src = { diag: c.diag, mags: this._smooth(c.mags).map(v => v + (pick.entry.offsetDb || 0)), color: INKS[pick.entry.color][0],
                           label: `${pick.entry.name}, ${this._whichLabel(pick.entry, pick.which)}`, short: this._whichLabel(pick.entry, pick.which) };
            if (src) list = [src];
        } else {
            for (const e of this._shown()) {
                const [ink, inkR] = INKS[e.color];
                for (const side of ['L', 'R', null]) {
                    if (side && !e.sides[side]) continue;
                    const c = this.store.sideCurve(e, side);
                    if (c) list.push({ diag: c.diag, mags: this._smooth(c.mags).map(v => v + (e.offsetDb || 0)), color: side === 'R' ? inkR : ink,
                                       label: side ? `${e.name} (${side})` : e.name, short: side ? `${e.name.slice(0, 16)} ${side}` : e.name.slice(0, 16) });
                }
            }
        }
        const place = placement(list, this.ui.normalizeHz);
        list.forEach((c, k) => { c.placed = c.mags.map(v => v + place[k].shift); c.note = place[k].note; });
        const t = this._target();
        const target = { label: t.name, mags: t.mags.map(v => v + (list[0] ? targetShift(list[0].placed, t.mags, this.ui.normalizeHz) : 0)) };
        let eq = null;
        if (src) {
            const filters = pick.entry.eq[pick.which];
            const resp = eqResponse(this.bypass ? [] : filters, GRID);
            eq = { result: src.placed.map((v, i) => v + resp[i]), handles: !this.bypass, showCurves: this.showFilterCurves && !this.bypass, baseline: 0,
                   filters: filters.map((x, i) => ({ ...x, color: FILTER_INKS[i % FILTER_INKS.length], response: filterResponse(x, GRID) })) };
        }
        const top = axisTop([...list.map(c => c.placed), target.mags, ...(eq ? [eq.result] : [])]);
        const range = Number(this.ui.rangeDb) || 50;
        if (eq) eq.baseline = top - range * 0.78;
        this.lastDrawn = { list, target, eq };
        this.graph.draw({
            top, range, unit: list[0] ? unitLabel(list[0].diag) : 'dB', inspect: !!this.ui.inspect, eq,
            curves: src ? [{ mags: src.placed, color: src.color, width: 2, alpha: 0.6 }] : list.map(c => ({ mags: c.placed, color: c.color })),
            target: { mags: target.mags },
            legend: [...list.map(c => ({ label: c.label + c.note, color: c.color })), ...(eq ? [{ label: 'With EQ', color: '#141413' }] : []),
                     { label: target.label, color: '#6c6a64' }],
            readout: [...list.map(c => ({ label: c.short, mags: c.placed, color: c.color })), ...(eq ? [{ label: 'With EQ', mags: eq.result, color: '#141413' }] : []),
                      { label: 'Target', mags: target.mags, color: '#6c6a64' }],
        });
    }

    // ---- the list and its cards ----------------------------------------------------------------
    _cardChange(e) {
        const t = e.target;
        if (t.dataset.rename) { const name = t.value.trim(); if (name) this.store.rename(t.dataset.rename, name); this.save(); this.render(); }
        else if (t.dataset.side) { const [id, s] = t.dataset.side.split('|'); this.store.entry(id).sides[s] = t.checked; this.save(); this.draw(); }
        else if (t.dataset.offset) { const v = Number(t.value); this.store.entry(t.dataset.offset).offsetDb = Number.isFinite(v) ? v : 0; this.save(); this.draw(); }
    }

    _cardClick(e) {
        const ex = e.target.closest('[data-export]'), del = e.target.closest('[data-delete]');
        const rm = e.target.closest('[data-remove]'), un = e.target.closest('[data-untarget]');
        if (ex) { const [id, kind] = ex.dataset.export.split('|'); this._exportEntry(this.store.entry(id), kind); }
        if (del) {
            const en = this.store.entry(del.dataset.delete);
            if (en && confirm(`Delete ${en.name} and its ${en.captures.length} sweeps? You can’t undo this.`)) {
                this.store.removeEntry(en.id);
                this.save();
                this.render();
            }
        }
        if (rm) {
            const [id, cid] = rm.dataset.remove.split('|'), en = this.store.entry(id), c = en && en.captures.find(x => x.id === cid);
            if (c && confirm(`Remove ${c.side ? `this ${c.side} sweep` : 'this curve'} from ${en.name}? You can’t undo this.`)) {
                this.store.removeCapture(id, cid);
                this.save();
                this.render();
            }
        }
        if (un) {
            const id = un.dataset.untarget;
            this.store.state.targets = this.store.state.targets.filter(t => t.id !== id);
            this.targets = this.targets.filter(t => t.id !== id);
            if (this.ui.target === id) this.ui.target = 'harman-ie-2019';
            this.save();
            this.render();
        }
    }

    _exportEntry(e, kind) {
        if (!e) return;
        for (const side of ['L', 'R', null]) {
            const c = this.store.sideCurve(e, side);
            if (!c) continue;
            const name = side ? `${e.name} ${side}` : e.name;
            if (kind === 'txt') download(fileName(name, '.txt'), exportTxt(GRID, c.mags, c.diag));
            else download(fileName(name, '.csv'), exportCsv(GRID, c.mags, c.diag), 'text/csv');
        }
    }

    _exportShown() {
        const d = this.lastDrawn;
        if (!d || !d.list.length) return this.status('Show a curve first: nothing is on the graph to export.', 'error');
        const unit = unitLabel(d.list[0].diag);
        const cols = [...d.list.map(c => ({ name: c.label + c.note, mags: c.placed })), { name: d.target.label, mags: d.target.mags },
                      ...(d.eq ? [{ name: 'With EQ', mags: d.eq.result }] : [])];
        const head = ['Frequency (Hz)', ...cols.map(c => `"${c.name.replace(/"/g, "'")} (${unit})"`)].join(',');
        const rows = GRID.map((f, i) => [f.toFixed(2), ...cols.map(c => (Number.isFinite(c.mags[i]) ? c.mags[i].toFixed(3) : ''))].join(','));
        download(fileName('RndB graph', '.csv'), [head, ...rows].join('\n') + '\n', 'text/csv');
    }

    _exportPng() {
        const a = document.createElement('a');
        a.download = fileName(this._selected()?.name || 'RndB graph', '.png');
        a.href = this.graph.png();
        a.click();
    }

    _average() {
        const shown = this._shown();
        try {
            const e = this.store.average(shown);
            for (const s of shown) s.show = false;
            e.show = true;
            this.ui.selected = e.id;
            this.status(`Averaged ${shown.length} entries into “${e.name}”.`, 'ok');
        } catch (err) { this.status(err.message, 'error'); }
        this.save();
        this.render();
    }

    async _importCurves(files) {
        const errors = [];
        let added = 0;
        for (const f of files) {
            try {
                const p = parseCurve(await f.text());
                const e = this.store.addEntry(f.name.replace(/\.[^.]+$/, ''));
                this.store.addCapture(e.id, null, { freqs: p.freqs, magnitudes: p.mags, diagnostics: { ...p.diag, imported: f.name } });
                this.ui.selected = e.id;
                added++;
            } catch (err) { errors.push(`${f.name}: ${err.message}`); }
        }
        if (added) { this.save(); this.render(); }
        this.status([added && `Imported ${added} curve${added === 1 ? '' : 's'}.`, ...errors].filter(Boolean).join(' '), errors.length ? 'error' : 'ok');
    }

    async _importTarget(file) {
        if (!file) return;
        try {
            const t = targetFromFile(file.name, await file.text());
            this.store.state.targets = [...this.store.state.targets.filter(x => x.id !== t.id), t];
            this.targets = [...this.targets.filter(x => x.id !== t.id), t];
            this.ui.target = t.id;
            this.status(`Imported the target “${t.name}”.`, 'ok');
            this.save();
            this.render();
        } catch (err) { this.status(`${file.name}: ${err.message}`, 'error'); }
    }

    async _importSession(file) {
        if (!file) return;
        try {
            const n = this.store.importSession(await file.text());
            this.targets = [...this.targets.filter(t => t.builtIn), ...this.store.state.targets];
            this.status(`Added ${n} entr${n === 1 ? 'y' : 'ies'} from ${file.name}.`, 'ok');
            this.save();
            this.render();
        } catch (err) { this.status(err.message, 'error'); }
    }

    // ---- the EQ --------------------------------------------------------------------------------
    _eqChanged(relist) {
        if (relist) this.renderEq(); else this.renderEqNumbers();
        this.save();
        this.draw();
    }

    _filterInput(e) {
        const el = e.target.closest('[data-k]'), card = e.target.closest('[data-filter]'), filters = this._filters();
        if (!el || !card || !filters) return;
        const i = Number(card.dataset.filter), x = filters[i], k = el.dataset.k;
        if (!x) return;
        if (k === 'delete') { if (e.type === 'click') { filters.splice(i, 1); this._eqChanged(true); } return; }
        if (e.type === 'click') return;
        if (k === 'on') { x.on = el.checked; return this._eqChanged(false); }
        if (k === 'type') {
            if (e.type !== 'change') return;
            x.type = el.value;
            if (x.type === 'HPQ' || x.type === 'LPQ') { x.gain = 0; x.q = 0.71; }
            return this._eqChanged(true);
        }
        const v = Number(el.value);
        if (!Number.isFinite(v)) return;
        if (k === 'f') x.f = Math.min(20000, Math.max(20, v));
        if (k === 'gain') x.gain = Math.min(24, Math.max(-24, v));
        if (k === 'q') x.q = Math.min(20, Math.max(0.1, v));
        this._eqChanged(false);
    }

    _moveFilter(i, change) {
        const filters = this._filters(), x = filters && filters[i];
        if (!x) return;
        if ('f' in change) x.f = Math.min(20000, Math.max(20, change.f));
        if ('gain' in change && x.type !== 'HPQ' && x.type !== 'LPQ') x.gain = Math.round(Math.min(24, Math.max(-24, change.gain)) * 10) / 10;
        if ('q' in change) x.q = Math.round(Math.min(20, Math.max(0.1, change.q)) * 100) / 100;
        const card = $('filterList').querySelector(`[data-filter="${i}"]`);
        if (card) {
            card.querySelector('[data-k="f"]').value = Math.round(x.f);
            card.querySelector('[data-k="gain"]').value = x.gain.toFixed(1);
            card.querySelector('[data-k="q"]').value = x.q.toFixed(2);
        }
        this._eqChanged(false);
    }

    _autoEq() {
        const { entry, which } = this._eqPick();
        const src = entry && this.store.eqCurve(entry, which);
        if (!src) return this.status('Measure or import a curve, then pick it under “EQ for”.', 'error');
        const m = this._smooth(src.mags, 12), t = this._target(), o = this._advanced();
        try {
            const r = autoEq(m, t.mags.map(v => v + targetShift(m, t.mags, this.ui.normalizeHz)), o);
            entry.eq[which] = r.filters;
            this.status(`AutoEQ to ${t.name}: ${r.filters.length} filters, RMS error ${r.rmsBefore.toFixed(1)} → ${r.rmsAfter.toFixed(1)} dB up to ${hz(o.fMax)}.`, 'ok');
        } catch (err) { this.status(err.message, 'error'); }
        this._eqChanged(true);
    }

    _channelMatch() {
        const { entry, which } = this._eqPick();
        const other = which === 'L' ? 'R' : 'L';
        const a = entry && this.store.sideCurve(entry, which), b = entry && this.store.sideCurve(entry, other);
        if (!a || !b) return this.status('Matching needs both an L and an R sweep: pick L or R under “EQ for”.', 'error');
        try {
            const r = channelMatch(this._smooth(a.mags, 12), this._smooth(b.mags, 12), { ...this._advanced(), maxBoost: 6, maxCut: 6 });
            entry.eq[which] = r.filters;
            const level = Math.abs(r.levelDb) < 0.05 ? 'The two sides are level at 1 kHz.'
                : `${r.levelDb > 0 ? other : which} is ${Math.abs(r.levelDb).toFixed(1)} dB louder at 1 kHz.`;
            this.status(`Matched ${which} to ${other}: RMS difference ${r.rmsBefore.toFixed(1)} → ${r.rmsAfter.toFixed(1)} dB. ${level}`, 'ok');
        } catch (err) { this.status(err.message, 'error'); }
        this._eqChanged(true);
    }

    _apoText() {
        const { entry, which } = this._eqPick();
        if (!entry) return null;
        if ($('apoBothCheck').checked && entry.eq.L.length && entry.eq.R.length)
            return toApo(entry.eq.L, { channel: 'L' }) + toApo(entry.eq.R, { channel: 'R' });
        return entry.eq[which].length ? toApo(entry.eq[which]) : null;
    }

    async _copyApo() {
        const text = this._apoText();
        if (!text) return this.status('Pick a curve and give it filters first.', 'error');
        try {
            await navigator.clipboard.writeText(text);
            this.status('Copied the APO text. Paste it into Equalizer APO, or any player that reads AutoEq’s ParametricEQ.txt.', 'ok');
        } catch {
            const { entry, which } = this._eqPick();
            download(fileName(`${entry.name} ${this._whichLabel(entry, which)}`, ' ParametricEQ.txt'), text);
            this.status('The clipboard was not available, so the APO text downloaded as a file instead.', 'ok');
        }
    }

    _downloadEq(kind) {
        const { entry, which } = this._eqPick(), filters = this._filters();
        if (!entry || !filters || !filters.length) return this.status('Pick a curve and give it filters first.', 'error');
        const base = `${entry.name} ${this._whichLabel(entry, which)}`;
        if (kind === 'graphic') download(fileName(base, ' GraphicEQ.txt'), toGraphicEq(filters));
        if (kind === 'csv') download(fileName(base, ' EQ.csv'), toCsv(filters), 'text/csv');
        if (kind === 'json') download(fileName(base, ' EQ.json'), toJson(filters), 'application/json');
    }

    async _importEq(file) {
        if (!file) return;
        const filters = this._filters();
        if (!filters) return this.status('Pick a curve to EQ first.', 'error');
        try {
            const text = await file.text();
            const r = /\.json$/i.test(file.name) ? fromJson(text) : /\.csv$/i.test(file.name) ? { filters: fromCsv(text) } : fromApo(text);
            filters.splice(0, filters.length, ...r.filters);
            this.status(`Read ${r.filters.length} filters from ${file.name}.`, 'ok');
            this._eqChanged(true);
        } catch (err) { this.status(`${file.name}: ${err.message}`, 'error'); }
    }

    _pasteApo() {
        const filters = this._filters();
        if (!filters) { $('pasteStatus').textContent = 'Pick a curve to EQ first.'; return; }
        try {
            const r = fromApo($('pasteText').value);
            filters.splice(0, filters.length, ...r.filters);
            $('pasteDialog').close();
            this.status(`Pasted ${r.filters.length} filters.`, 'ok');
            this._eqChanged(true);
        } catch (err) { $('pasteStatus').textContent = err.message; }
    }
}

// app.js makes window.app on DOMContentLoaded; a module runs before that fires.
function waitForApp(tries) {
    if (window.app && window.app.engine) { window.studio = new Studio(window.app); return; }
    if (tries > 50) { console.warn('studio: the app never started'); return; }
    setTimeout(() => waitForApp(tries + 1), 100);
}
waitForApp(0);
