// The studio's targets (website/app/js/studio/targets.mjs, data/targets.json) and the graph's
// arithmetic (js/studio/graph.mjs: axes, the pen lifting over a gap). The canvas itself is
// checked in the browser. V4_APP_DIR names the app's folder; test_website_app.py runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP = pathToFileURL(process.env.V4_APP_DIR.replace(/[\\/]*$/, "/"));
const C = await import(new URL("js/studio/curves.mjs", APP));
const T = await import(new URL("js/studio/targets.mjs", APP));
const G = await import(new URL("js/studio/graph.mjs", APP));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

test("the built-in targets: AutoEq's four 711 targets on the app grid, 0 dB at 1 kHz, the licence carried", () => {
  const j = JSON.parse(fs.readFileSync(path.join(process.env.V4_APP_DIR, "data", "targets.json"), "utf8"));
  assert.deepEqual(j.targets.map(t => t.id), ["harman-ie-2019", "harman-ie-2019-nb", "autoeq-ie", "df-kemar"]);
  assert.match(j.license, /^MIT License\s+Copyright \(c\) 2018-2022 Jaakko Pasanen/);
  for (const t of j.targets) {
    assert.equal(t.mags.length, 300, t.id);
    near(C.valueAt(C.GRID, t.mags, 1000), 0, 0.05, t.id);
  }
  assert.ok(j.targets[0].mags[0] - j.targets[1].mags[0] > 6, "Harman 2019 carries its bass shelf; without bass does not");
});

test("an imported target reads like a curve, 0 dB at 1 kHz, named after its file", () => {
  const text = "frequency,raw\n" + C.GRID.map(f => `${f.toFixed(2)},${f < 100 ? 10 : 3}`).join("\n");
  const t = T.targetFromFile("My target.csv", text);
  assert.equal(t.name, "My target");
  assert.equal(t.id, "user-my-target");
  assert.equal(t.builtIn, false);
  near(C.valueAt(C.GRID, t.mags, 1000), 0, 1e-9);
  near(t.mags[0], 7, 1e-9);
  assert.ok(T.FLAT.mags.length === 300 && T.FLAT.mags.every(v => v === 0));
});

test("the graph's axes: log frequency across, dB down, and back again", () => {
  const ax = G.axes(1000, 500, 15, 50);
  near(ax.x(20), ax.x0, 1e-9);
  near(ax.x(20000), ax.x1, 1e-9);
  near(ax.f(ax.x(1234)), 1234, 1e-6);
  near(ax.y(15), ax.y0, 1e-9);
  near(ax.y(-35), ax.y1, 1e-9);
  near(ax.db(ax.y(-7.5)), -7.5, 1e-9);
});

test("a gap lifts the pen: runs of finite points, never a bridge", () => {
  assert.deepEqual(G.runs([1, 2, NaN, NaN, 3, 4, 5, NaN]), [[0, 1], [4, 5, 6]]);
  assert.deepEqual(G.runs([NaN]), []);
  assert.equal(G.nearest(1000), 169, "1 kHz is grid point 169");
  assert.equal(G.nearest(5), 0);
});
