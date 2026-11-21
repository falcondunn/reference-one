// The studio's curve files (website/app/js/studio/parse.mjs). The exports must be what the old
// Graph tab wrote, byte for byte in format; the importer reads our files, REW's, squiglink's,
// PEQdB's and AutoEq's. V4_APP_DIR names the app's folder; test_website_app.py runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const APP = pathToFileURL(process.env.V4_APP_DIR.replace(/[\\/]*$/, "/"));
const C = await import(new URL("js/studio/curves.mjs", APP));
const P = await import(new URL("js/studio/parse.mjs", APP));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

const shape = C.GRID.map(f => 4 * Math.exp(-(((Math.log10(f) - 3.5) / 0.3) ** 2)) -
                              3 * Math.exp(-(((Math.log10(f) - 1.7) / 0.4) ** 2)));
const s1k = C.valueAt(C.GRID, shape, 1000);
const curve = (offset, diag) => ({ freqs: C.GRID, mags: shape.map(v => v - s1k + offset), diag: { warnings: [], ...diag } });
const relative = curve(0, { normalizedAt: 1000, unit: "dB rel" });
const v4 = curve(110, { normalizedAt: 0, unit: "dB SPL/V" });
const spl = curve(94, { unit: "dB SPL" });
const raw = curve(-40, { unit: "dB rel" });
const txt = c => P.exportTxt(c.freqs, c.mags, c.diag);
const csv = c => P.exportCsv(c.freqs, c.mags, c.diag);

test("the .txt: a relative or raw curve at 75 dB as before; an absolute one as measured", () => {
  const rows = t => t.split("\n").filter(r => /^\d/.test(r)).map(r => r.split(" ").map(Number));
  const at1k = t => rows(t).reduce((b, r) => (Math.abs(Math.log(r[0] / 1000)) < Math.abs(Math.log(b[0] / 1000)) ? r : b))[1];
  const rel = txt(relative);
  assert.match(rel.split("\n")[0], /^20\.00 -?\d+\.\d{3}$/, "no header");
  assert.equal(rows(rel).length, 384);
  near(at1k(rel), 75, 0.1, "the 75 dB convention");
  assert.equal(txt(raw), rel, "a raw sweep has no honest level either");
  near(at1k(txt(v4)), 110, 0.1, "a V4's sensitivity, as measured");
  near(at1k(txt(spl)), 94, 0.1, "the Rev 3's dB SPL, as measured");
});

test("the .csv: as measured, the unit in the header, a gap left out", () => {
  const a = csv(v4).split("\n");
  assert.equal(a[0], "Frequency (Hz),Level (dB SPL/V)");
  assert.equal(a.length, 302, "a header, 300 points, the final newline");
  assert.equal(csv(relative).split("\n")[0], "Frequency (Hz),Level (dB re 1000 Hz)");
  assert.equal(csv(spl).split("\n")[0], "Frequency (Hz),Level (dB SPL)");
  assert.equal(csv(raw).split("\n")[0], "Frequency (Hz),Level (dB rel)");
  assert.equal(csv({ ...relative, mags: relative.mags.map((v, i) => (i < 10 ? NaN : v)) }).split("\n").length, 292);
});

test("file names follow the old rule", () => {
  assert.equal(P.fileName('Blessing 2: "stock"', ".csv"), "Blessing 2 stock.csv");
  assert.equal(P.fileName("", ".txt"), "RndB measurement.txt");
  assert.equal(P.fileName("::", ".txt"), "RndB measurement.txt");
});

test("our own .csv comes back as it went: an absolute curve stays absolute", () => {
  const back = P.parseCurve(csv(v4));
  assert.equal(back.diag.unit, "dB SPL/V");
  assert.equal(back.diag.normalizedAt, 0);
  near(C.valueAt(back.freqs, back.mags, 1000), 110, 0.01);
  const rel = P.parseCurve(csv(relative));
  assert.equal(rel.diag.normalizedAt, 1000);
  near(C.valueAt(rel.freqs, rel.mags, 1000), 0, 1e-9);
});

test("our .txt, REW, squiglink/PEQdB and AutoEq files read as relative curves, 0 dB at 1 kHz", () => {
  const same = (p, msg) => near(C.valueAt(p.freqs, p.mags, 3162), C.valueAt(C.GRID, relative.mags, 3162), 0.05, msg);
  const t = P.parseCurve(txt(relative));
  near(C.valueAt(t.freqs, t.mags, 1000), 0, 1e-9);
  same(t, "our .txt keeps its shape");
  const rew = "* Measurement data measured by REW V5.20\n* Source: Reference One\n* Freq(Hz) SPL(dB) Phase(degrees)\n" +
              C.GRID.map((f, i) => `${f.toFixed(3)} ${(80 + relative.mags[i]).toFixed(3)} -12.0`).join("\n");
  const r = P.parseCurve(rew);
  near(C.valueAt(r.freqs, r.mags, 1000), 0, 1e-9);
  assert.equal(r.diag.normalizedAt, 1000);
  same(r, "REW");
  same(P.parseCurve("frequency,raw\n" + C.GRID.map((f, i) => `${f.toFixed(2)},${(75 + relative.mags[i]).toFixed(2)}`).join("\n")), "squiglink");
  same(P.parseCurve("frequency,raw,error,smoothed\n" + C.GRID.map((f, i) => `${f.toFixed(2)},${relative.mags[i].toFixed(2)},9,9`).join("\n")),
       "AutoEq: the raw column, not error or smoothed");
  assert.equal(P.parseCurve(C.GRID.map((f, i) => `${f.toFixed(2)};${relative.mags[i].toFixed(2)}`).join("\r\n")).freqs.length, 300,
               "semicolons and CRLF");
});

test("a file it cannot read says which line, and gives back nothing", () => {
  assert.throws(() => P.parseCurve("frequency,raw\n20,1\n30,two\n"), /Line 3/);
  assert.throws(() => P.parseCurve("20 1\n30 2\n"), /at least 10/);
  assert.throws(() => P.parseCurve(Array.from({ length: 20 }, (_, i) => `${1000 + i} 0`).join("\n")), /200 Hz to 5 kHz/);
});
