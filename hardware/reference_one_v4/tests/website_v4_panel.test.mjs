// The measurement app's V4 tab as the user drives it (website/app/js/v4/v4-panel.mjs), with
// stand-ins for its elements and an engine that is the V4's digital twin. Nothing plays: the
// point is that nothing even tries to until the user has said no earphone is in an ear.
// V4_APP_DIR names the app's folder; tests/test_website_app.py sets it and runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const APP = pathToFileURL(process.env.V4_APP_DIR.replace(/[\\/]*$/, "/"));
const v4 = await import(new URL("js/v4/v4core.mjs", APP));

// ---- the page: elements made on first use, each keeping its listeners -------------------------
const els = {};
const downloads = [];                                // what the page would save, by name and contents
URL.createObjectURL = blob => blob;
URL.revokeObjectURL = () => {};
const element = () => ({
  click() { downloads.push({ name: this.download, blob: this.href }); },
  disabled: false, checked: false, textContent: "", className: "", style: {}, files: null, children: [],
  handlers: {}, addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); },
  replaceChildren(...c) { this.children = c; },
  getBoundingClientRect: () => ({ width: 0, height: 0 }),          // hidden: nothing to draw
  async fire(type, ev = {}) { for (const fn of this.handlers[type] ?? []) await fn({ target: this, ...ev }); },
});
const nav = element();
globalThis.document = {
  getElementById: id => (els[id] ??= element()),
  createElement: () => element(),
  querySelector: sel => (sel === '[data-tab="rig"]' ? nav : null),
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = fn => fn();
const said = () => els.v4Result.children[0]?.textContent ?? "";

// ---- the app, with the twin for its engine ------------------------------------------------------
const pow2 = n => { let p = 1; while (p < n) p <<= 1; return p; };
const twin = { mode: "impedance", load: 32 };
let sweeps = 0, seed = 1;
const progressSeen = [];
const engine = {
  isConnected: true, deviceKind: "v4", isDefault: false, codecs: 1,
  async defaultOutputIsV4() { return this.isDefault; },
  async codecDeviceCount() { return this.codecs; },
  async playSweep(type, seconds, levelDb, onProgress, { drive, freq }) {
    sweeps++;
    if (onProgress) { onProgress(50); progressSeen.push(said()); }   // what the page says mid-sweep
    const n = Math.round(seconds * v4.FS), fade = Math.round(0.01 * v4.FS);
    const base = type === "tone"                    // the engine's tone, 10 ms fades
      ? Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * freq * i / v4.FS) * Math.min(1, i / fade, (n - 1 - i) / fade))
      : v4.logSweep(20, 20000, seconds);
    const stim = Float32Array.from(base, s => 10 ** (levelDb / 20) * s);
    const pad = pow2(stim.length + Math.round(1.3 * v4.FS));
    const c = v4.simulateCapture(stim, () => [twin.load, 0], { noise: v4.TWIN_NOISE.typical, seed: seed++, pad, latency: 2400 });
    let ch1 = c.ch1;
    if (twin.mode === "measure") {       // the mic hears the tip: 110 dB SPL/V, 2.7 samples later
      const re = new Float64Array(pad), im = new Float64Array(pad);
      re.set(stim);
      v4.fft(re, im);
      const g = -v4.HW.gainNormal * v4.HW.adcDivider * v4.HW.preampGain * 10 ** (-38 / 20) * 20e-6 * 10 ** (110 / 20);
      for (let k = 0; k < pad; k++) {
        const kk = k <= pad / 2 ? k : k - pad, ph = -2 * Math.PI * kk * (2400 + 2.7) / pad;
        const cr = g * Math.cos(ph), ci = g * Math.sin(ph), r = re[k] * cr - im[k] * ci;
        im[k] = re[k] * ci + im[k] * cr; re[k] = r;
      }
      v4.fft(re, im, true);
      let s2 = 977 + seed;                          // the codec's noise on the mic channel, then its grid
      const gauss = () => { s2 = (s2 * 16807) % 2147483647; const u = s2 / 2147483647;
        s2 = (s2 * 16807) % 2147483647; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * s2 / 2147483647); };
      const sd = Math.SQRT1_2 * 10 ** (v4.TWIN_NOISE.typical.ch1 / 20);
      ch1 = re.map(v => Math.round((v + sd * gauss()) * 32768) / 32768);
    }
    return { reference: stim, recording: ch1, recording2: c.ch2, levelDb, channels: 2, drive };
  },
};
const captured = [];
globalThis.app = { engine, onCapture: (side, fr) => captured.push({ side, fr }), _exportName: () => "Blessing 2" };
await import(new URL("js/v4/v4-panel.mjs", APP));
await new Promise(r => setTimeout(r, 50));                 // the panel waits for window.app
const click = id => els[id].fire("click");

test("nothing sweeps until the user says no earphone is in an ear, or while disconnected", async () => {
  await click("v4CheckBtn");
  assert.match(said(), /no earphone is in anyone's ear/);
  engine.isConnected = false;
  els.v4Safe.checked = true;
  await click("v4ZLBtn");
  assert.match(said(), /Connect the V4 first/);
  assert.equal(sweeps, 0, "no sweep was even attempted");
  engine.isConnected = true;
});

test("Check, impedance and response, then the response goes to the measurement list", async () => {
  els.v4Safe.checked = true;
  await click("v4CheckBtn");
  assert.match(said(), /A V4, in NORMAL/);
  assert.equal(els.v4ZCsvBtn.disabled, true, "no impedance to export yet");
  await click("v4ZLBtn");
  assert.match(said(), /ohm at 1 kHz/);
  assert.match(progressSeen.at(-1), /Impedance L: playing L at -20 dBFS, 50 %/, "a sweep shows its progress");
  assert.equal(captured.length, 0, "an impedance is not a response");
  assert.equal(els.v4ZCsvBtn.disabled, false);
  await click("v4ZCsvBtn");
  assert.equal(downloads.at(-1).name, "Blessing 2 impedance.csv", "named like the app's other exports");
  assert.match(await downloads.at(-1).blob.text(), /^Frequency \(Hz\),\|Z\| L \(ohm\),Phase L \(deg\)\n\d+\.\d\d,32\.\d{4},/);
  twin.mode = "measure";
  await click("v4SLBtn");
  assert.match(said(), /dB SPL\/V at 1 kHz/);
  assert.equal(captured.length, 1, "the response lands in the list by itself");
  assert.equal(captured[0].side, "L");
  assert.equal(captured[0].fr.label, "V4 response L");
  assert.equal(captured[0].fr.freqs.length, 300, "the app's grid");
  assert.ok(Math.abs(captured[0].fr.magnitudes[169] - 110) < 0.5, `${captured[0].fr.magnitudes[169]} dB SPL/V at 1 kHz`);
  await click("v4TLBtn");                           // the twin's earphone has no distortion
  assert.match(said(), /THD below the measurement floor at \d+\.\d Hz, about \d+ dB SPL/);
  assert.equal(captured.length, 1, "a THD tone is not a response");
});

test("the toolbar's Measure goes through the same guards: no tick, no sweep", async () => {
  els.v4Safe.checked = false;
  const before = sweeps;
  const r = await app.v4Measure("R");
  assert.equal(r.ok, false);
  assert.match(r.message, /no earphone is in anyone's ear/);
  assert.equal(sweeps, before, "nothing played");
  els.v4Safe.checked = true;
});

test("while the V4 is the system's default output, the tab says so (spec 12.4)", async () => {
  els.v4Safe.checked = true;
  engine.isDefault = true;
  await click("v4CheckBtn");
  assert.equal(document.getElementById("v4DefaultWarn").style.display, "", "shown");
  engine.isDefault = false;
  await click("v4CheckBtn");
  assert.equal(document.getElementById("v4DefaultWarn").style.display, "none", "gone once another device is the default");
});

test("a second device named USB AUDIO CODEC is pointed out: the V4 cannot be told from it by name", async () => {
  // the owner's own mic interface is built on the same TI chip: Windows lists the second one as
  // "2- USB AUDIO CODEC", and a sweep on the wrong one first read as "MODE unknown" (2026-10-19)
  engine.codecs = 2;
  await click("v4CheckBtn");
  assert.equal(document.getElementById("v4CodecWarn").style.display, "", "shown");
  engine.codecs = 1;
  await click("v4CheckBtn");
  assert.equal(document.getElementById("v4CodecWarn").style.display, "none", "gone with one");
});

test("a refused calibration file says why, and leaves none loaded", async () => {
  const file = { text: async () => JSON.stringify({ format: v4.CAL.format, version: 1, simulated: true }) };
  await els.v4CalFile.fire("change", { target: { files: [file] } });
  assert.match(said(), /refused: .*digital twin/);
  assert.match(els.v4CalInfo.textContent, /None loaded/);
});

test("a unit's file by its serial, from this site's data/v4-calibration/", async () => {
  const nominal = { normal: v4.db(v4.PREFLIGHT.normal), high: v4.db(v4.PREFLIGHT.high) };
  const good = { format: v4.CAL.format, version: v4.CAL.version, serial: "V4-0001", date: "2026-10-02",
                 k: { L: 1.002, R: 0.998 }, skew: { L: 0.334e-6, R: 0.334e-6 }, nominal: { L: nominal, R: nominal } };
  const asked = [];
  globalThis.fetch = async url => {
    asked.push(url);
    if (url.endsWith("V4-0001.json")) return { ok: true, json: async () => good };
    if (url.endsWith("V4-0003.json")) return { ok: true, json: async () => ({ ...good, serial: "V4-0002" }) };
    return { ok: false, status: 404 };
  };
  document.getElementById("v4Serial").value = "V4-0009";
  await click("v4SerialBtn");
  assert.match(said(), /No calibration file for V4-0009 .*404/);
  document.getElementById("v4Serial").value = "V4-0003";
  await click("v4SerialBtn");
  assert.match(said(), /for unit V4-0002, not V4-0003/, "another unit's file under this serial is refused");
  document.getElementById("v4Serial").value = " V4-0001 ";
  await click("v4SerialBtn");
  assert.equal(asked.at(-1), "data/v4-calibration/v4-calibration-V4-0001.json", "the bench page's file name");
  assert.match(els.v4CalInfo.textContent, /Unit V4-0001: K 1\.0020 left/);
});

test("a browser still running the old audio engine from its cache is told to reload", async () => {
  // The engine from before the V4 wiring: one buffer to both sides, at the level asked, back as
  // { recording, reference } with no level or channel count, and the engine has no deviceKind.
  const { playSweep } = engine;
  engine.playSweep = async (type, seconds, levelDb) => {
    const c = await playSweep("log", seconds, levelDb, null, { drive: "left" });
    return { recording: c.recording, reference: c.reference, sampleRate: v4.FS, duration: seconds, sweepType: type };
  };
  delete engine.deviceKind;
  const { defaultOutputIsV4 } = engine;
  delete engine.defaultOutputIsV4;                  // that engine predates the default-output check too
  twin.mode = "impedance";
  els.v4Safe.checked = true;
  await click("v4CheckBtn");
  assert.match(said(), /^✗ .*audio engine is out of date/);
  assert.doesNotMatch(said(), /USB AUDIO CODEC/, "the device is not what is wrong");
  assert.equal(els.v4CheckBtn.disabled, false, "the buttons come back: the tab is not left stuck");
  engine.playSweep = playSweep;
  engine.deviceKind = "v4";
  engine.defaultOutputIsV4 = defaultOutputIsV4;
});
