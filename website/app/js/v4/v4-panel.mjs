/**
 * RndB Measure - the Reference One V4 panel, in the Rig tab: the DOM around v4-session.mjs.
 *
 * Everything that decides anything is in v4-session.mjs, which is tested on the V4's digital
 * twin. This file wires buttons to it, hands it the app's AudioEngine as its sweep, draws the
 * results, and hands each response to the studio's measurement list (app.onCapture).
 *
 * Nothing here plays until the user has confirmed no earphone is in anyone's ear, and every
 * sweep asks for -20 dBFS on one side (the engine caps a V4 there anyway, and the session
 * refuses a sweep that came back louder).
 */
import { V4Session, V4_LEVEL_DB, onAppGrid, calibrationFileName, impedanceCsv } from "./v4-session.mjs?v=2026-10-19.2";

const $ = id => document.getElementById(id);
const BUTTONS = ["v4CheckBtn", "v4KBtn", "v4ZLBtn", "v4ZRBtn", "v4SLBtn", "v4SRBtn", "v4TLBtn", "v4TRBtn", "v4ZCsvBtn"];
const COLORS = { L: "#2350a0", R: "#b8382c" };            // the website's left and right

function start(app) {
    let doing = "";                                      // the action running, for its progress line
    const session = new V4Session(async ({ side, seconds, levelDb, tone }) => {
        const progress = pct => {                        // Calibrate K alone sweeps 40 s
            const b = $("v4Result").children[0];
            if (b) b.textContent = `✓ ${doing}: playing ${side} at ${V4_LEVEL_DB} dBFS, ${Math.round(pct)} %`;
        };
        const c = await app.engine.playSweep(tone ? "tone" : "log", seconds, levelDb, progress,
                                             { drive: side === "L" ? "left" : "right", freq: tone });
        return { stim: c.reference, ch1: c.recording, ch2: c.recording2 || c.recording,
                 levelDb: c.levelDb, channels: c.channels || 1 };
    });

    const show = (ok, text) => {
        const el = $("v4Result"), badge = document.createElement("div");
        badge.className = "result-badge " + (ok ? "success" : "error");
        badge.textContent = (ok ? "✓ " : "✗ ") + text;
        el.replaceChildren(badge);
        el.style.display = "block";
    };
    const busy = on => {
        for (const id of BUTTONS) $(id).disabled = on;
        if (!on) $("v4ZCsvBtn").disabled = !(session.z.L || session.z.R);
    };
    const blocked = () => {
        if (!app.engine.isConnected) return "Connect the V4 first: Connect is at the top of the Rig tab.";
        if (!$("v4Safe").checked) return "First confirm that no earphone is in anyone's ear.";
        return null;
    };

    /** Run one session action with the buttons held, show what it said, and return it as { ok, message }. */
    const act = async (what, fn) => {
        const why = blocked();
        if (why) { show(false, why); return { ok: false, message: why }; }
        busy(true);
        doing = what;
        show(true, `${what}: sweeping at ${V4_LEVEL_DB} dBFS…`);
        let out;
        try {
            out = await fn();
            show(out.ok, out.message);
            // An old engine from the browser's cache has no deviceKind: the session names that.
            if (app.engine.deviceKind && app.engine.deviceKind !== "v4" && !out.ok)
                show(false, out.message + " (This device's name is not TI's USB AUDIO CODEC, which a V4's is.)");
            draw();
        } catch (err) {
            out = { ok: false, message: `${what} failed: ${err.message}` };
            show(false, out.message);
        }
        // Spec 12.4: while the V4 is the system's default output, every app's sound plays through it.
        // An engine that cannot tell (an old cached one, no device list) leaves the warning as it was.
        try { $("v4DefaultWarn").style.display = await app.engine.defaultOutputIsV4() ? "" : "none"; } catch { }
        // Spec 12.13: every product on the V4's chip is named USB AUDIO CODEC, so a second one
        // plugged in (the owner's own mic interface is one) cannot be told from the V4 by name.
        try { $("v4CodecWarn").style.display = (await app.engine.codecDeviceCount()) > 1 ? "" : "none"; } catch { }
        busy(false);
        return out;
    };

    // A response on the app's grid, as the measurement list takes one.
    const asFR = side => {
        const g = onAppGrid(session.responses[side].f, session.responses[side].dbSplPerV);
        return { freqs: g.freqs, magnitudes: g.values, label: `V4 response ${side}`,
                 diagnostics: { warnings: [], inputPeakDb: NaN, snrDb: NaN, latencyMs: NaN, gateMs: 0,
                                calibrated: !!session.cal, normalizedAt: 0, unit: "dB SPL/V" } };
    };
    // Response L/R, from this panel or the studio's Measure buttons: the same act(), so the same
    // guards. Each response lands in the measurement list by itself.
    app.v4Measure = side => act(`Response ${side}`, async () => {
        const r = await session.response(side);
        if (r.ok) app.onCapture?.(side, asFR(side));
        return r;
    });

    $("v4CheckBtn").addEventListener("click", () => act("Check", () => session.check()));
    $("v4KBtn").addEventListener("click", () => act("Calibrate K", () => session.calibrateK()));
    for (const side of ["L", "R"]) {
        $(`v4Z${side}Btn`).addEventListener("click", () => act(`Impedance ${side}`, () => session.impedance(side)));
        $(`v4S${side}Btn`).addEventListener("click", () => app.v4Measure(side));
        $(`v4T${side}Btn`).addEventListener("click", () => act(`THD ${side}`, () => session.thd(side)));
    }

    // A unit's calibration file, from disk or from this site by its serial (spec 12.10).
    const loadCal = (json, opts) => {
        try {
            const r = session.loadCalibration(json, opts);
            $("v4CalInfo").textContent = `Unit ${r.serial}: K ${r.k.L.toFixed(4)} left, ${r.k.R.toFixed(4)} right`;
            draw();
            show(true, `Calibration for ${r.serial} loaded. Run Check again: the file sets the V4's own level.`);
        } catch (err) {
            $("v4CalInfo").textContent = "None loaded: K = 1, mic -38 dBV/Pa (datasheet)";
            show(false, `That calibration file was refused: ${err.message}`);
        }
        busy(false);
    };
    $("v4CalFile").addEventListener("change", async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try { loadCal(JSON.parse(await f.text())); } catch (err) { show(false, `That file is not JSON: ${err.message}`); }
    });
    // The bench page saves each unit's file as calibrationFileName(serial). Copied into this
    // site's data/v4-calibration/, it is found by the serial printed on the base.
    $("v4SerialBtn").addEventListener("click", async () => {
        const serial = $("v4Serial").value.trim();
        if (!serial) return show(false, "Type the serial printed on the base first.");
        const name = calibrationFileName(serial), url = `data/v4-calibration/${name}`;
        let res;
        try { res = await fetch(url, { cache: "no-store" }); } catch (err) {
            return show(false, `Could not fetch ${url} (${err.message}): open the app through its web server, not as a file.`);
        }
        if (!res.ok)
            return show(false, `No calibration file for ${serial} on this site (${url}: ${res.status}). The bench page ` +
                               `saves it as ${name}: copy it into data/v4-calibration/, or load it with the file button.`);
        let json;
        try { json = await res.json(); } catch (err) { return show(false, `${url} is not JSON: ${err.message}`); }
        loadCal(json, { serial });
    });

    // The impedance has no tab of its own to go to: it leaves as a file, named like the app's others.
    $("v4ZCsvBtn").addEventListener("click", () => {
        const csv = impedanceCsv(session.z);
        if (!csv) return;
        const link = document.createElement("a");
        link.download = app._exportName() + " impedance.csv";
        link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        link.click();
        URL.revokeObjectURL(link.href);
    });

    function draw() {
        const z = [], s = [];
        for (const side of ["L", "R"]) {
            if (session.z[side]) z.push({ ...onAppGrid(session.z[side].f, session.z[side].mag), color: COLORS[side], label: side });
            if (session.responses[side])
                s.push({ ...onAppGrid(session.responses[side].f, session.responses[side].dbSplPerV), color: COLORS[side], label: side });
        }
        plot($("v4ZCanvas"), z, "|Z|, ohm");
        plot($("v4SCanvas"), s, "dB SPL/V");
    }
    // A hidden canvas has no size, so draw (axes, or the curves again) when the Rig tab opens.
    document.querySelector('[data-tab="rig"]').addEventListener("click", () => requestAnimationFrame(draw));
    busy(false);
    console.log("V4 tab ready");
}

/** Curves on a log frequency axis, 20 Hz to 20 kHz, the y axis fitted to them. */
function plot(canvas, curves, unit) {
    const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (rect.width < 1 || rect.height < 1) return;          // hidden: drawn again with the next result
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height, p = { top: 20, bottom: 26, left: 52, right: 16 };
    const pw = w - p.left - p.right, ph = h - p.top - p.bottom;
    const x = f => p.left + Math.log(f / 20) / Math.log(1000) * pw;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#ddd4c5";
    ctx.fillStyle = "#6c6a64";
    ctx.font = "12px Inter, sans-serif";
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        ctx.beginPath(); ctx.moveTo(x(f), p.top); ctx.lineTo(x(f), h - p.bottom); ctx.stroke();
        if ([20, 100, 1000, 10000, 20000].includes(f)) {
            ctx.textAlign = "center";
            ctx.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x(f), h - 8);
        }
    }
    ctx.textAlign = "left";
    ctx.fillText(unit, p.left + 4, p.top - 6);
    const vals = curves.flatMap(c => c.values.filter(Number.isFinite));
    if (!vals.length) return;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
    lo -= pad; hi += pad;
    const y = v => p.top + ph - (v - lo) / (hi - lo) * ph;
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
        const v = lo + (hi - lo) * i / 4;
        ctx.beginPath(); ctx.moveTo(p.left, y(v)); ctx.lineTo(w - p.right, y(v)); ctx.stroke();
        ctx.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1), p.left - 4, y(v) + 3);
    }
    for (const c of curves) {
        ctx.beginPath();
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 2;
        let pen = false;
        c.freqs.forEach((f, i) => {
            const v = c.values[i];
            if (!Number.isFinite(v)) { pen = false; return; }
            if (pen) ctx.lineTo(x(f), y(v)); else { ctx.moveTo(x(f), y(v)); pen = true; }
        });
        ctx.stroke();
        ctx.fillStyle = c.color;
        ctx.textAlign = "right";
        ctx.fillText(c.label, w - p.right, y(c.values.filter(Number.isFinite).at(-1)) - 6);
    }
}

// app.js makes window.app on DOMContentLoaded; a module runs before that fires.
function waitForApp(tries) {
    if (window.app && window.app.engine) return start(window.app);
    if (tries > 50) return console.warn("V4 tab: the app never started");
    setTimeout(() => waitForApp(tries + 1), 100);
}
waitForApp(0);
