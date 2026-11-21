// The measurement app's smoothing (analysis.js) and its Connect shortlist (app.js). The graph's
// rules, the exports and the L/R figures moved to the studio's modules and their tests.
// V4_APP_DIR names the app's folder; tests/test_website_app.py sets it and runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = f => fs.readFileSync(path.join(process.env.V4_APP_DIR, "js", f), "utf8");
const els = {};
globalThis.window = globalThis;
globalThis.document = {
  addEventListener() {},                            // the app starts on DOMContentLoaded: not here
  getElementById: id => (els[id] ??= { value: "", checked: false, innerHTML: "", style: {}, on: {},
                                       addEventListener(type, fn) { this.on[type] = fn; } }),
  querySelectorAll: () => [],
};
vm.runInThisContext(read("analysis.js"));
vm.runInThisContext(read("audio-engine.js") + "\n;globalThis.AudioEngine = AudioEngine;");
vm.runInThisContext(read("app.js") + "\n;globalThis.RndBMeasure = RndBMeasure;");

const app = Object.create(RndBMeasure.prototype);    // its constructor wants the whole page
Object.assign(app, { analysis: window.analysis, engine: {} });

// One earphone's shape on the app's grid: a bass dip and a 3 kHz peak, 0 dB at 1 kHz.
const freqs = Array.from({ length: 300 }, (_, i) => 20 * 1000 ** (i / 299));
const shape = freqs.map(f => 4 * Math.exp(-(((Math.log10(f) - 3.5) / 0.3) ** 2)) -
                             3 * Math.exp(-(((Math.log10(f) - 1.7) / 0.4) ** 2)));
const s1k = window.analysis._valueAt(freqs, shape, 1000);
const curve = (offset, diagnostics) => ({ freqs, magnitudes: shape.map(v => v - s1k + offset),
                                          diagnostics: { warnings: [], ...diagnostics } });
const v4 = curve(110, { normalizedAt: 0, unit: "dB SPL/V", calibrated: false });     // as the V4 panel sends it

test("smoothing keeps a gap a gap, and does not spread it", () => {
  const m = v4.magnitudes.map((v, i) => (i >= 100 && i < 110 ? NaN : v));
  const s = window.analysis.smooth(freqs, m, 3);
  assert.ok(s.slice(100, 110).every(Number.isNaN), "the gap");
  assert.ok(s.every((v, i) => (i >= 100 && i < 110) || Number.isFinite(v)), "and nothing else");
});

test("Connect shortlists a V4 only when it is the one USB AUDIO CODEC (the owner's mic interface shares the name)", async () => {
  const dev = (kind, deviceId, label) => ({ kind, deviceId, label });
  const run = async (inputs, outputs) => {
    for (const id of ["audioInputSelect", "audioOutputSelect"]) Object.assign(document.getElementById(id), { value: "", innerHTML: "" });
    app.engine = { requestPermission: async () => true, listDevices: async () => ({ inputs, outputs }) };
    await app._checkDevices();
    const v = id => document.getElementById(id).value;
    return { in: v("audioInputSelect"), out: v("audioOutputSelect"), info: document.getElementById("connectInfo").innerHTML };
  };
  const v4in = dev("audioinput", "v4i", "Line (2- USB AUDIO  CODEC)"), v4out = dev("audiooutput", "v4o", "Speakers (2- USB AUDIO  CODEC)");
  const alone = await run([dev("audioinput", "default", "Default - Line (2- USB AUDIO  CODEC)"), v4in], [v4out]);
  assert.deepEqual([alone.in, alone.out], ["v4i", "v4o"], "the V4 itself, not Chrome's default alias");
  const both = await run([dev("audioinput", "ifi", "Line (USB AUDIO  CODEC)"), v4in],
                         [dev("audiooutput", "ifo", "Speakers (USB AUDIO  CODEC)"), v4out]);
  assert.deepEqual([both.in, both.out], ["", ""], "two of them: nothing guessed");
  assert.match(both.info, /More than one device is named/);
});
