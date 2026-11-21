// The measurement app's audio engine (website/app/js/audio-engine.js): the V4's level cap and
// the sweep it builds, through stand-ins for the browser's audio objects. Nothing plays.
// V4_APP_DIR names the app's folder; tests/test_website_app.py sets it and runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const src = fs.readFileSync(path.join(process.env.V4_APP_DIR, "js", "audio-engine.js"), "utf8");
globalThis.document = { dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
vm.runInThisContext(src + "\n;globalThis.AudioEngine = AudioEngine;");
const { AudioEngine } = globalThis;

const peakDb = x => 20 * Math.log10(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0));

test("device kinds: a Rev 3 by name, a V4 only as TI's generic codec name", () => {
  assert.equal(AudioEngine.deviceKind("Microphone (Reference One)"), "rev3");
  assert.equal(AudioEngine.deviceKind("Headphones (RndB Explore)"), "rev3");
  assert.equal(AudioEngine.deviceKind("Microphone (USB AUDIO  CODEC)"), "v4");
  assert.equal(AudioEngine.deviceKind("Default - Speakers (USB Audio CODEC)"), "v4");
  for (const l of ["Microphone (USB Audio Device)", "Webcam C920", "", undefined]) assert.equal(AudioEngine.deviceKind(l), "other", l);
});

test("the sweep: unchanged for a Rev 3, capped and one channel for a V4", () => {
  const rev3 = AudioEngine.makeStimulus({ type: "log", duration: 1, level: -14, sampleRate: 48000 });
  assert.equal(rev3.channels.length, 1);
  assert.equal(rev3.levelDb, -14);
  assert.ok(Math.abs(peakDb(rev3.channels[0]) + 14) < 0.01, `${peakDb(rev3.channels[0])}`);
  for (const level of [-6, -8, -12, -14, NaN]) {
    const s = AudioEngine.makeStimulus({ type: "log", duration: 1, level, sampleRate: 48000, drive: "left", capDb: -20 });
    assert.equal(s.levelDb, -20, `${level}`);
    assert.ok(peakDb(s.channels[0]) <= -20 + 0.01, `${level}: ${peakDb(s.channels[0])}`);
  }
  const quiet = AudioEngine.makeStimulus({ type: "log", duration: 1, level: -26, sampleRate: 48000, capDb: -20 });
  assert.equal(quiet.levelDb, -26, "under the cap is left alone");
  const left = AudioEngine.makeStimulus({ type: "log", duration: 1, level: -20, sampleRate: 48000, drive: "left" });
  const right = AudioEngine.makeStimulus({ type: "log", duration: 1, level: -20, sampleRate: 48000, drive: "right" });
  assert.equal(left.channels.length, 2);
  assert.ok(peakDb(left.channels[0]) > -21 && left.channels[1].every(v => v === 0), "left driven, right silent");
  assert.ok(right.channels[0].every(v => v === 0) && peakDb(right.channels[1]) > -21, "right driven, left silent");
  assert.deepEqual(Array.from(left.reference), Array.from(left.channels[0]), "the reference is what plays");
});

/** A browser with these devices, a getUserMedia that records the constraints, and a context. */
function browser({ inputs, outputs, defaultOut = null, channelCount = 2, suspended = false, neverEnds = false }) {
  const asked = [];
  const devs = [...inputs.map(([deviceId, label]) => ({ kind: "audioinput", deviceId, label })),
                ...outputs.map(([deviceId, label]) => ({ kind: "audiooutput", deviceId, label }))];
  if (defaultOut) devs.push({ kind: "audiooutput", deviceId: "default", label: `Default - ${defaultOut}` });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { mediaDevices: {
    enumerateDevices: async () => devs,
    getUserMedia: async c => { asked.push(c);
      return { getAudioTracks: () => [{ label: "x", getSettings: () => ({ channelCount }), stop() {} }], getTracks: () => [] }; },
  } } });
  const played = [];
  class Ctx {   // a suspended context plays nothing until resumed; neverEnds is a device that went away
    constructor() { this.sampleRate = 48000; this.currentTime = 0; this.destination = {}; this.state = suspended ? "suspended" : "running"; }
    async resume() { this.state = "running"; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async setSinkId() {}
    createBuffer(n, len) { const chans = Array.from({ length: n }, () => new Float32Array(len));
      const b = { numberOfChannels: n, getChannelData: i => chans[i] }; played.push(b); return b; }
    createBufferSource() { const ctx = this, s = { connect() {}, start() {
      const end = () => (ctx.state === "running" ? s.onended() : setTimeout(end, 10));
      if (!neverEnds) setTimeout(end, 0); } }; return s; }
    close() {}
  }
  globalThis.window = { AudioContext: Ctx };
  return { asked, played };
}

test("connect caps a V4 at -20 dBFS, by its output as well as its input", async () => {
  const cases = [
    [{ inputs: [["i", "Microphone (USB AUDIO  CODEC)"]], outputs: [["o", "Speakers (USB AUDIO  CODEC)"]] }, "i", "o", -20, true],
    [{ inputs: [["i", "Microphone (Realtek)"]], outputs: [["o", "Speakers (USB AUDIO  CODEC)"]] }, "i", "o", -20, false],
    [{ inputs: [["i", "Microphone (Realtek)"]], outputs: [["o", "Speakers (Realtek)"]],
       defaultOut: "Speakers (USB AUDIO  CODEC)" }, "i", "", -20, false],
    [{ inputs: [["i", "Microphone (Reference One)"]], outputs: [["o", "Headphones (Reference One)"]] }, "i", "o", null, false],
  ];
  for (const [devices, inId, outId, cap, two] of cases) {
    const { asked } = browser(devices);
    const e = new AudioEngine();
    assert.ok(await e.connect(inId, outId), "connected");
    assert.equal(e.levelCapDb, cap, JSON.stringify(devices));
    assert.equal(!!asked[0].audio.channelCount, two, `two channels asked: ${JSON.stringify(devices)}`);
  }
});

test("it knows when a V4 is the system's default output, where every app's sound plays uncapped (spec 12.4)", async () => {
  for (const [defaultOut, want] of [["Speakers (USB AUDIO  CODEC)", true], ["Speakers (Realtek)", false]]) {
    browser({ inputs: [["i", "Microphone (USB AUDIO  CODEC)"]], outputs: [["o", "Speakers (USB AUDIO  CODEC)"]], defaultOut });
    const e = new AudioEngine();
    await e.connect("i", "o");
    assert.equal(await e.defaultOutputIsV4(), want, defaultOut);
  }
});

test("playSweep plays what the cap allows, on the side asked, and returns both channels", async () => {
  const { played } = browser({ inputs: [["i", "Microphone (USB AUDIO  CODEC)"]], outputs: [["o", "Speakers (USB AUDIO  CODEC)"]] });
  const e = new AudioEngine();
  await e.connect("i", "o");
  e._startRecording = async () => { e.captured = [new Float32Array(48000).fill(0.25)]; e.captured2 = [new Float32Array(48000).fill(0.5)]; };
  e._stopRecording = async () => {};
  const c = await e.playSweep("log", 1, -6, null, { drive: "right" });
  const b = played[played.length - 1];
  assert.equal(b.numberOfChannels, 2);
  assert.ok(b.getChannelData(0).every(v => v === 0), "left silent");
  assert.ok(peakDb(b.getChannelData(1)) <= -20 + 0.01, `right at the cap: ${peakDb(b.getChannelData(1))}`);
  assert.equal(c.levelDb, -20);
  assert.equal(c.drive, "right");
  assert.equal(c.channels, 2);
  assert.equal(c.recording[0], 0.25);
  assert.equal(c.recording2[0], 0.5);
});

test("a suspended context is resumed, and a sweep that never ends rejects instead of hanging", async () => {
  const open = async opts => {
    browser({ inputs: [["i", "Microphone (USB AUDIO  CODEC)"]], outputs: [["o", "Speakers (USB AUDIO  CODEC)"]], ...opts });
    const e = new AudioEngine();
    await e.connect("i", "o");
    e._startRecording = async () => { e.captured = [new Float32Array(48000)]; e.captured2 = [new Float32Array(48000)]; };
    e._stopRecording = async () => {};
    return e;
  };
  const resumed = await open({ suspended: true });
  const c = await resumed.playSweep("log", 0.05, -20, null, { drive: "left" });
  assert.equal(c.channels, 2, "it played once resumed");
  const gone = await open({ neverEnds: true });
  const t0 = Date.now();
  await assert.rejects(gone.playSweep("log", 0.05, -20, null, { drive: "left" }), /never finished/);
  assert.ok(Date.now() - t0 < 6000, "within seconds, not never");
});

test("a tone for THD: one frequency on the side asked, capped like a sweep", () => {
  const t = AudioEngine.makeStimulus({ type: "tone", freq: 999.32, duration: 2, level: -6, sampleRate: 48000,
                                       drive: "left", capDb: -20 });
  assert.equal(t.levelDb, -20);
  assert.ok(Math.abs(peakDb(t.channels[0]) + 20) < 0.01, `${peakDb(t.channels[0])}`);
  assert.ok(t.channels[1].every(v => v === 0), "right silent");
  // the steady part is a sine at that frequency: one cycle later it repeats
  const x = t.channels[0], period = 48000 / 999.32, i = 48000;
  const j = Math.round(i + 10 * period), frac = i + 10 * period - j;
  assert.ok(Math.abs(x[i] - (x[j] + frac * (x[j + 1] - x[j - 1]) / 2)) < 2e-3, "periodic at the tone's frequency");
  assert.throws(() => AudioEngine.makeStimulus({ type: "tone", duration: 1, level: -20, sampleRate: 48000 }), /frequency/);
});
