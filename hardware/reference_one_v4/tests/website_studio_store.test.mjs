// The studio's measurement list (website/app/js/studio/store.mjs): one entry per earphone, its L
// and R captures, REW's RMS average per side, saving, the old History coming in, sessions.
// V4_APP_DIR names the app's folder; test_website_app.py runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const APP = pathToFileURL(process.env.V4_APP_DIR.replace(/[\\/]*$/, "/"));
const C = await import(new URL("js/studio/curves.mjs", APP));
const S = await import(new URL("js/studio/store.mjs", APP));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const fr = (offset, diag, gapAt = -1) => ({ freqs: C.GRID, magnitudes: C.GRID.map((f, i) => (i === gapAt ? NaN : offset + Math.sin(i / 20))),
                                            diagnostics: { warnings: [], ...diag } });
const REL = { normalizedAt: 1000, unit: "dB rel" }, V4 = { normalizedAt: 0, unit: "dB SPL/V" };

test("one entry per earphone: its L and R captures, each side the RMS average of its sweeps", () => {
  const st = new S.Store(memory());
  const e = st.addEntry("IE 200");
  st.addCapture(e.id, "L", fr(100, V4));
  st.addCapture(e.id, "L", fr(110, V4));
  st.addCapture(e.id, "R", fr(105, V4));
  const L = st.sideCurve(e, "L"), R = st.sideCurve(e, "R");
  assert.equal(L.count, 2);
  near(L.mags[0], 10 * Math.log10((1e10 + 1e11) / 2), 1e-9);
  assert.equal(R.count, 1);
  assert.equal(st.sideCurve(e, null), null, "no unsided capture");
  near(st.eqCurve(e, "avg").mags[0], C.rmsAverage([L.mags, R.mags])[0], 1e-12, "L and R averaged for the EQ");
  assert.deepEqual(st.eqCurve(e, "L").mags, L.mags, "L alone for the EQ");
});

test("an entry holds one kind: a relative capture into a V4 entry is refused", () => {
  const st = new S.Store(memory());
  const e = st.addEntry("IE 200");
  st.addCapture(e.id, "L", fr(110, V4));
  assert.throws(() => st.addCapture(e.id, "R", fr(0, REL)), /holds dB SPL\/V curves; this one is relative/);
  assert.equal(e.captures.length, 1);
});

test("colours: the first entry is blue and red, the next their own inks, a freed ink used again", () => {
  const st = new S.Store(memory());
  const a = st.addEntry("A"), b = st.addEntry("B");
  assert.deepEqual(S.INKS[a.color], ["#2350a0", "#b8382c"]);
  assert.notEqual(b.color, a.color);
  st.removeEntry(a.id);
  assert.equal(st.addEntry("C").color, 0);
});

test("saved and loaded: gaps come back as gaps, not zeros", () => {
  const mem = memory(), st = new S.Store(mem);
  const e = st.addEntry("IE 200");
  st.addCapture(e.id, "L", fr(110, V4, 3));
  assert.equal(st.save(), true);
  const back = new S.Store(mem).load(), c = back.state.entries[0].captures[0];
  assert.ok(Number.isNaN(c.mags[3]) && Number.isFinite(c.mags[4]));
  assert.equal(back.state.entries[0].name, "IE 200");
  assert.deepEqual(back.state.entries[0].eq, { L: [], R: [], avg: [] });
});

test("a full browser store is reported, not ignored", () => {
  const st = new S.Store({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } });
  st.addEntry("A");
  assert.equal(st.save(), false);
});

test("the old History comes in once, each saved curve an entry with one unsided capture", () => {
  const mem = memory();
  mem.setItem(S.HISTORY_KEY, JSON.stringify([
    { fr: { freqs: C.GRID, magnitudes: C.GRID.map(() => 1), diagnostics: REL }, label: "Blessing 2, stock", timestamp: "2026-10-02T12:00:00Z" },
    { fr: { freqs: C.GRID, magnitudes: C.GRID.map(() => 2), diagnostics: REL }, label: "Chu II", timestamp: "2026-10-03T12:00:00Z" }]));
  const st = new S.Store(mem).load();
  assert.deepEqual(st.state.entries.map(e => e.name), ["Blessing 2, stock", "Chu II"]);
  const e = st.state.entries[0];
  assert.equal(e.captures[0].side, null);
  assert.equal(e.captures[0].at, "2026-10-02T12:00:00Z");
  assert.deepEqual(st.state.entries.map(x => x.show), [false, true], "only the newest is shown at first");
  st.save();
  assert.equal(new S.Store(mem).load().state.entries.length, 2, "not again once the studio has saved");
  assert.ok(mem.getItem(S.HISTORY_KEY), "the old key is left in place");
});

test("Average: shown entries of one kind into a new one; mixed kinds refused", () => {
  const st = new S.Store(memory());
  const a = st.addEntry("A"), b = st.addEntry("B");
  st.addCapture(a.id, "L", fr(100, V4));
  st.addCapture(b.id, "L", fr(110, V4));
  const m = st.average([a, b]);
  assert.equal(m.name, "Average of 2");
  near(st.sideCurve(m, "L").mags[0], 10 * Math.log10((1e10 + 1e11) / 2), 1e-9);
  const c = st.addEntry("C");
  st.addCapture(c.id, null, fr(0, REL));
  assert.throws(() => st.average([a, c]), /different scales/);
  assert.throws(() => st.average([a]), /at least two/);
});

test("a session file round-trips, and a damaged one is refused whole", () => {
  const st = new S.Store(memory());
  const e = st.addEntry("IE 200");
  st.addCapture(e.id, "L", fr(110, V4, 2));
  e.eq.L = [{ type: "PK", f: 1000, gain: -3, q: 1, on: true }];
  const text = st.exportSession();
  const other = new S.Store(memory());
  assert.equal(other.importSession(text), 1);
  const back = other.state.entries[0];
  assert.equal(back.name, "IE 200");
  assert.deepEqual(back.eq.L, e.eq.L);
  assert.ok(Number.isNaN(back.captures[0].mags[2]));
  const bad = JSON.parse(text);
  bad.entries[0].captures[0].mags = [1, 2, 3];
  assert.throws(() => other.importSession(JSON.stringify(bad)), /not on this app's grid/);
  assert.equal(other.state.entries.length, 1, "nothing added");
  assert.throws(() => other.importSession("{}"), /not an RndB session/);
});
