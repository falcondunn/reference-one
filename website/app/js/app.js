/**
 * RndB Measure — Main Application
 */
class RndBMeasure {
    constructor() {
        this.engine = new AudioEngine();
        this.analysis = window.analysis;
        this.calibration = null;
        this.levelAnim = null;

        this._bindUI();
        this._bindAudioEvents();
        this._checkDevices();

        // Substitution calibration measured against a known Chu II curve.
        // Absent or unreadable is not fatal - measurements just stay relative.
        this.analysis.loadCalibration('data/calibration.json')
            .then(c => { const b = document.getElementById('calibrateBtn');
                         if (b && c.absoluteSpl) { b.disabled = true;
                             b.title = 'Absolute calibration already loaded'; } return c; })
            .then(c => console.log(`calibration loaded: ${c.validBand[0].toFixed(0)}-` +
                                   `${c.validBand[1].toFixed(0)} Hz, ` +
                                   `${c.absoluteSpl ? 'dB SPL' : 'relative'}`))
            .catch(e => console.warn('no calibration loaded, curves stay relative:', e.message));

        console.log('RndB Measure v1.0 initialized');
    }

    // ─── UI Binding ───────────────────────────────

    _bindUI() {
        document.getElementById('refreshBtn').addEventListener('click', () => this._checkDevices());
        document.getElementById('connectBtn').addEventListener('click', () => this._connect());
        document.getElementById('calibrateBtn').addEventListener('click', () => this._runCalibration());
    }

    _bindAudioEvents() {
        document.addEventListener('audio:connected', (e) => {
            document.getElementById('statusDot').className = 'status-dot online';
            const isRndb = this.engine.isRndBDevice;
            const brand = isRndb ? 'RndB ' : '';
            const status = e.detail.isExplore ? 'Explore' : (isRndb ? 'Device' : 'Connected');
            // A V4 has no name of its own, so "maybe": the V4 tab's Check decides.
            document.getElementById('statusText').textContent = e.detail.deviceKind === 'v4'
                ? `A V4? Run Check in the Rig tab · ${e.detail.sampleRate} Hz · every sweep at −20 dBFS`
                : `${brand}${status} · ${e.detail.sampleRate} Hz`;
            document.getElementById('sampleRateDisplay').textContent = e.detail.sampleRate + ' Hz';
            document.getElementById('calibrateBtn').disabled = false;
            this._startLevelMeter();
        });

        document.addEventListener('audio:disconnected', () => {
            document.getElementById('statusDot').className = 'status-dot offline';
            document.getElementById('statusText').textContent = 'No hardware: connect a Reference One in the Rig tab';
            this._stopLevelMeter();
        });
    }

    // ─── Device Detection & Connection ────────────

    async _checkDevices() {
        const granted = await this.engine.requestPermission();
        if (!granted) {
            document.getElementById('connectInfo').innerHTML =
                '<p>Please allow microphone access when prompted. Needed to detect audio devices.</p>';
            document.getElementById('connectBtn').disabled = true;
            return;
        }

        const { inputs, outputs } = await this.engine.listDevices();
        const inputSel = document.getElementById('audioInputSelect');
        const outputSel = document.getElementById('audioOutputSelect');

        inputSel.innerHTML = inputs.map(d =>
            `<option value="${d.deviceId}">${d.label || 'Unnamed device'}</option>`
        ).join('') || '<option disabled>No devices found</option>';
        inputSel.disabled = inputs.length === 0;

        outputSel.innerHTML = outputs.map(d =>
            `<option value="${d.deviceId}">${d.label || 'Default'}</option>`
        ).join('');
        outputSel.disabled = outputs.length === 0;

        const hasAny = inputs.length > 0;
        document.getElementById('connectBtn').disabled = !hasAny;

        if (hasAny) {
            // Match BOTH endpoints. The board is one USB Audio device presenting
            // a playback and a capture endpoint, and a loopback measurement is
            // only valid if the sweep leaves and returns through the same
            // hardware - otherwise you measure the room, not the earphone.
            // 'usb audio' is deliberately NOT matched here: it is the generic
            // name Windows gives ANY class-compliant device, so it would happily
            // select someone's webcam.
            const isRefOne = l => AudioEngine.isReferenceOne(l);
            const rndb = inputs.find(d => isRefOne(d.label));
            const rndbOut = outputs.find(d => isRefOne(d.label));
            if (rndb) inputSel.value = rndb.deviceId;
            if (rndbOut) outputSel.value = rndbOut.deviceId;

            const info = document.getElementById('connectInfo');
            if (rndb && rndbOut) {
                info.innerHTML =
                    '<p style="color:var(--accent)">&#10003; Reference One detected on both input and output. Click Connect.</p>';
            } else if (rndbOut && !rndb) {
                // Exactly what the playback-only firmware looks like.
                info.innerHTML =
                    '<p style="color:var(--accent)">&#10003; Reference One found as an OUTPUT, but it is not offering a microphone.</p>' +
                    '<p style="color:var(--ink-dim)">That is the playback-only firmware. You can listen through it, but measuring needs the build with capture enabled.</p>';
            } else if (rndb && !rndbOut) {
                info.innerHTML =
                    '<p style="color:var(--accent)">&#10003; Reference One microphone found, but no matching output.</p>' +
                    '<p style="color:var(--ink-dim)">Pick it as the output too, or the sweep will play somewhere else and the measurement will be of the room.</p>';
            } else if (inputs.some(d => AudioEngine.deviceKind(d.label) === 'v4') &&
                       outputs.some(d => AudioEngine.deviceKind(d.label) === 'v4')) {
                // A V4 enumerates as TI's generic "USB AUDIO CODEC", like every
                // other PCM290x product (board spec 12.13), a mic interface too.
                // Shortlist it only when it is the one, by its own id rather than
                // Chrome's "default" alias; the V4 tab's Check confirms it.
                const codec = d => d.deviceId !== 'default' && d.deviceId !== 'communications' &&
                                   AudioEngine.deviceKind(d.label) === 'v4';
                const ins = inputs.filter(codec), outs = outputs.filter(codec);
                if (ins.length === 1 && outs.length === 1) {
                    inputSel.value = ins[0].deviceId;
                    outputSel.value = outs[0].deviceId;
                    info.innerHTML =
                        '<p style="color:var(--accent)">&#10003; A “USB AUDIO CODEC” is plugged in: it may be a Reference One V4, which has no name of its own.</p>' +
                        '<p style="color:var(--ink-dim)">Click Connect, then run Check in the V4 panel below. Every sweep on it plays at -20 dBFS.</p>';
                } else {
                    info.innerHTML =
                        '<p style="color:var(--accent)">More than one device is named “USB AUDIO CODEC”: every PCM290x interface is.</p>' +
                        '<p style="color:var(--ink-dim)">Choose the V4 in both lists (Windows numbers the newer one “2- …”), click Connect, then run Check in the V4 panel below, which confirms it from its signal.</p>';
                }
            } else {
                document.getElementById('connectInfo').innerHTML =
                    '<p>Select your RndB device from the list and click Connect. Make sure it\'s plugged in via USB-C.</p>';
            }
        } else {
            document.getElementById('connectInfo').innerHTML =
                '<p>No input devices found. Plug in your RndB Reference One.</p>';
        }
    }

    async _connect() {
        const inputId = document.getElementById('audioInputSelect').value;
        const btn = document.getElementById('connectBtn');
        btn.textContent = 'Connecting…';
        btn.disabled = true;

        const outputId = document.getElementById('audioOutputSelect').value;
        const ok = await this.engine.connect(inputId, outputId);

        btn.textContent = 'Connect';
        btn.disabled = false;

        if (ok) {
            this._watchDeviceLoss();
            const inLabel = document.getElementById('audioInputSelect')
                .selectedOptions[0]?.textContent || '';
            const outLabel = document.getElementById('audioOutputSelect')
                .selectedOptions[0]?.textContent || '';
            let msg = '<p style="color:var(--green)">Connected. Measure L and Measure R are ready.</p>';

            // A measurement is only meaningful if the sweep goes out of the same
            // box it comes back into. Say so plainly rather than producing a
            // confident-looking curve of the room.
            if (this.engine.deviceKind === 'v4') {
                msg = '<p style="color:var(--green)">&#10003; Connected. Run Check in the V4 panel below: it confirms a V4 from its signal. Every sweep on it plays at -20 dBFS.</p>';
            }
            if (!this.engine.outputRouted && this.engine.outputRouteError) {
                msg += `<p style="color:var(--red)">&#9888; Could not route playback to the chosen output. ${this.engine.outputRouteError}</p>`;
            } else if (AudioEngine.deviceKind(inLabel) !== AudioEngine.deviceKind(outLabel)) {
                msg += '<p style="color:var(--red)">&#9888; Input and output are different devices. A sweep played on one and recorded on the other measures the room, not your earphones.</p>';
            }
            document.getElementById('connectInfo').innerHTML = msg;
        } else {
            document.getElementById('connectInfo').innerHTML =
                '<p style="color:var(--red)">&#10007; Connection failed. Check your device and try again.</p>';
        }
    }

    // ─── Level Meter ──────────────────────────────

    _startLevelMeter() {
        if (!this.engine.audioContext || !this.engine.inputDevice) return;
        const analyser = this.engine.audioContext.createAnalyser();
        analyser.fftSize = 256;
        this.engine.inputDevice.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
            if (!this.engine.isConnected) return;
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (const v of data) sum += Math.abs(v - 128);
            const avg = sum / data.length;
            const db = avg < 1 ? -60 : 20 * Math.log10(avg / 128);
            this._showLevel(Math.max(-60, db));
            this.levelAnim = requestAnimationFrame(tick);
        };
        tick();
    }

    _stopLevelMeter() {
        if (this.levelAnim) cancelAnimationFrame(this.levelAnim);
        this._showLevel(-60);
    }

    /** The Rig tab's input meter: -60 to 0 dB across the bar, red above -3 dB, ochre above -6. */
    _showLevel(db) {
        const fill = document.getElementById('levelBarFill'), label = document.getElementById('levelDb');
        if (!fill || !label) return;
        fill.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
        fill.style.background = db > -3 ? '#b8382c' : db > -6 ? '#8a5d0c' : '#2b6e43';
        label.textContent = db <= -60 ? '−∞ dB' : db.toFixed(1) + ' dB';
    }

    // ─── Measurement ──────────────────────────────

    /**
     * Find gaps in a capture.
     *
     * The board's USB wedges under capture and the watchdog resets it. When
     * that lands mid-sweep the recording keeps its level and its
     * signal-to-noise - it simply has a HOLE. A level gate cannot see that.
     *
     * It matters more than it sounds, because a log sweep maps time to
     * frequency: 10 Hz to 23.5 kHz passes 150 Hz about 35% of the way through,
     * so a dropout there removes the energy at 150 Hz and the deconvolution
     * reports a deep notch at 150 Hz. Observed exactly that on 2026-09-08 - a
     * second sweep with a scoop at 150 Hz that looked like a seal problem and
     * was a dropped USB buffer.
     *
     * Chrome fills a starved capture with zeros, so runs of exact silence
     * inside the sweep are the tell. Leading and trailing silence are normal
     * and excluded.
     */
    _findDropouts(rec, sampleRate) {
        const EPS = 1e-7;
        const MIN_RUN = Math.max(8, Math.round(sampleRate * 0.0005));  // 0.5 ms
        let first = -1, last = -1;
        for (let i = 0; i < rec.length; i++) {
            if (Math.abs(rec[i]) > 1e-4) { if (first < 0) first = i; last = i; }
        }
        if (first < 0) return { gaps: 0, worstMs: 0, totalMs: 0 };
        let gaps = 0, worst = 0, total = 0, run = 0;
        for (let i = first; i <= last; i++) {
            if (Math.abs(rec[i]) <= EPS) { run++; continue; }
            if (run >= MIN_RUN) { gaps++; total += run; if (run > worst) worst = run; }
            run = 0;
        }
        if (run >= MIN_RUN) { gaps++; total += run; if (run > worst) worst = run; }
        return { gaps, worstMs: worst * 1000 / sampleRate,
                 totalMs: total * 1000 / sampleRate };
    }
    /**
     * Notice when the capture device disappears.
     *
     * The board reboots itself out of a USB wedge, so the device really can
     * vanish mid-session. Chrome does not always end the track when that
     * happens - it can go on delivering silence - so watch both the track and
     * the device list, and say so plainly rather than letting the next sweep
     * return a curve made of nothing.
     */
    _watchDeviceLoss() {
        const warn = (why) => {
            const el = document.getElementById('measureResult');
            if (!el) return;
            el.innerHTML = '<div class="result-badge error">&#9888; ' + why +
                ' Click Connect again before measuring.</div>';
            el.style.display = 'block';
            this.engine.isConnected = false;
        };
        const tr = this.engine.stream && this.engine.stream.getAudioTracks
            ? this.engine.stream.getAudioTracks()[0] : null;
        if (tr && !tr.__rndbWatched) {
            tr.__rndbWatched = true;
            tr.addEventListener('ended', () => warn('The capture device ended.'));
            tr.addEventListener('mute', () => warn('The capture device went silent.'));
        }
        if (!this.__devWatch) {
            this.__devWatch = true;
            navigator.mediaDevices.addEventListener('devicechange', async () => {
                if (!this.engine.isConnected) return;
                const hw = await this.engine.findHardware();
                if (!hw.input) warn('The Reference One disappeared from the device list.');
            });
        }
    }

    /**
     * Run a sweep, and survive the board resetting itself mid-capture.
     *
     * The firmware watchdog recovers a wedged board without a replug, but the
     * device re-enumerates on the way through. The browser is left holding a
     * MediaStreamTrack for hardware that went away - and a stale track does not
     * reliably fire 'ended', it just delivers silence. So a retry MUST tear the
     * connection down and rebuild it, not simply call playSweep again.
     *
     * Measured 2026-09-11: MTBF is ~55 s with capture open, and a 3 s sweep
     * takes ~4 s end to end. Most attempts succeed; the ones that do not fail
     * for a reason this already detects (silence, low S/N, or a time-domain
     * gap), so retrying is honest rather than papering over a bad capture.
     *
     * @param {function(string):void} onStatus - progress text for the user
     * @returns {Promise<object>} a capture that PASSED the validity gate
     */
    async _sweepWithRetry(type, duration, level, onProgress, onStatus, maxTries = 4) {
        let lastErr = null;
        for (let attempt = 1; attempt <= maxTries; attempt++) {
            if (attempt > 1) {
                onStatus(`Board reset mid-sweep - reconnecting (attempt ${attempt} of ${maxTries})…`);
                // Rebuild the connection. Without this the retry captures
                // silence from a dead track and the gate rejects it forever.
                try { this.engine.disconnect(); } catch {}
                const ok = await this._reconnectWhenReady();
                if (!ok) {
                    throw new Error(
                        'The board did not come back after resetting itself. ' +
                        'Unplug it and plug it back in, then press Connect.');
                }
            }
            try {
                const capture = await this.engine.playSweep(type, duration, level, onProgress);
                this._assertCaptureValid(capture);
                return capture;
            } catch (err) {
                lastErr = err;
                // Only retry the failures that a reset causes. A genuine
                // problem - nothing plugged into the jack, say - should be
                // reported at once rather than retried four times.
                if (!this._isRecoverable(err)) throw err;
            }
        }
        throw new Error(
            `${lastErr ? lastErr.message : 'Measurement failed'} ` +
            `(gave up after ${maxTries} attempts)`);
    }

    /**
     * Throw unless this capture is a real measurement.
     *
     * The board's USB wedges under capture and the firmware watchdog resets it.
     * That recovers without a replug, but the browser keeps a
     * MediaStreamTrack for hardware that went away - and a stale track does not
     * reliably fire 'ended', it just delivers silence. Without this gate every
     * sweep after a reset drew a confident-looking curve made of nothing.
     *
     * Same checks the Python tooling has always had, which is why that path
     * printed REJECT while this one drew garbage.
     */
    _assertCaptureValid(capture) {
        const dg = this.analysis.extractFR(capture, {}).diagnostics;
        // A torn capture keeps its level and its S/N and only loses a slice of
        // the sweep, so it has to be caught in the TIME domain.
        const drop = this._findDropouts(capture.recording, capture.sampleRate);
        if (drop.gaps && drop.totalMs > 1.0) {
            throw new Error(
                `The capture has ${drop.gaps} gap(s) totalling
                 ${drop.totalMs.toFixed(1)} ms (worst ${drop.worstMs.toFixed(1)} ms).
                 A sweep sweeps frequency over time, so a gap punches a notch into
                 the result at whatever frequency was sounding - it looks like a
                 real dip and is not.`.replace(/\s+/g, ' '));
        }
        if (dg.inputPeakDb < -60) {
            throw new Error(
                `Input peak was ${dg.inputPeakDb.toFixed(1)} dBFS - essentially
                 silence, so nothing was captured.`.replace(/\s+/g, ' '));
        }
        if (isFinite(dg.snrDb) && dg.snrDb < 20) {
            throw new Error(
                `Signal-to-noise was only ${dg.snrDb.toFixed(0)} dB, far below what
                 a valid sweep produces.`.replace(/\s+/g, ' '));
        }
    }

    /** Does this failure look like the board resetting itself, or a real fault? */
    _isRecoverable(err) {
        const m = (err && err.message ? err.message : '').toLowerCase();
        return m.includes('gap') || m.includes('silence') || m.includes('signal-to-noise')
            || m.includes('not connected') || m.includes('device') || m.includes('stream')
            || m.includes('nothing was captured');
    }

    /** Wait for the device to re-enumerate, then reconnect to the same IDs. */
    async _reconnectWhenReady(timeoutMs = 20000) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            await new Promise(r => setTimeout(r, 750));
            try {
                // Re-enumerate: after a reset the deviceId can change, so the
                // stored one may no longer exist.
                await this.engine.listDevices();
                const inputId = document.getElementById('audioInputSelect').value;
                const outputId = document.getElementById('audioOutputSelect').value;
                if (await this.engine.connect(inputId, outputId)) return true;
            } catch {}
        }
        return false;
    }

    /**
     * The Rev 3's sweeps are wrong for a V4. They deconvolve one channel against
     * the stimulus, through the Rev 3's SPL calibration: on a V4 that channel is
     * the earphone's voltage or a different mic, and the calibration is another
     * rig's. Say so, and send the user to the V4 panel. measure() already routes
     * a V4 there; this guard is for calibration and any direct call.
     */
    _refuseOnV4(id) {
        if (this.engine.deviceKind !== 'v4') return false;
        this._showMsg(id, 'This looks like a Reference One V4. Measure it with the V4 panel in the Rig tab: this sweep is the Rev 3\'s, ' +
            'and on a V4 it would read the wrong channel through another rig\'s calibration.', false);
        return true;
    }

    /**
     * Measure one side, from the studio's Measure L/R or Space. A Rev 3 sweeps here; a V4 goes
     * through its panel's own Response, whose act() holds the no-earphone tick. Either way the
     * curve reaches the studio through onCapture. Returns { ok, message }.
     */
    async measure(side) {
        if (side !== 'L' && side !== 'R') return { ok: false, message: 'Measure L or R.' };
        if (!this.engine.isConnected) return { ok: false, message: 'Connect a Reference One to measure: open the Rig tab.' };
        if (this.engine.deviceKind === 'v4')
            return this.v4Measure ? this.v4Measure(side) : { ok: false, message: 'The V4 panel has not started. Reload the page (Ctrl+Shift+R).' };
        return this._runSweep(side);
    }

    async _runSweep(side) {
        if (!this.engine.isConnected) {
            const message = 'Connect a Reference One to measure: open the Rig tab.';
            this._showMsg('measureResult', message, false);
            return { ok: false, message };
        }
        if (this._refuseOnV4('measureResult'))
            return { ok: false, message: 'This looks like a Reference One V4: measure it with the V4 panel in the Rig tab.' };

        const type = document.getElementById('sweepType').value;
        const duration = parseInt(document.getElementById('sweepDuration').value);
        const level = parseInt(document.getElementById('sweepLevel').value);
        const buttons = ['measureLBtn', 'measureRBtn'].map(id => document.getElementById(id));

        document.getElementById('measureProgress').style.display = 'block';
        document.getElementById('measureResult').style.display = 'none';
        buttons.forEach(b => { b.disabled = true; });

        let result;
        try {
            const capture = await this._sweepWithRetry(type, duration, level,
                (pct) => {
                    document.getElementById('progressFill').style.width = pct + '%';
                    document.getElementById('progressText').textContent = 'Measuring… ' + Math.round(pct) + '%';
                    this.onProgress?.(pct);
                },
                (status) => {
                    document.getElementById('progressText').textContent = status;
                });

            document.getElementById('progressText').textContent = 'Analysing…';
            // The capture carries both the recording and the exact reference
            // sweep. extractFR throws if either is missing rather than
            // inventing a curve, so a failed measurement reads as a failure.
            // Raw means BOTH switches off: no calibration and no 1 kHz
            // normalisation. Leaving normalisation on would still hide a gain
            // error, which is usually the thing raw mode is being used to find.
            const raw = document.getElementById('sweepScale').value === 'raw';
            const fr = this.analysis.extractFR(capture,
                raw ? { calibrate: false, normalizeAt: 0 } : {});
            fr.label = raw ? 'Measurement (raw)' : 'Measurement';
            fr.side = side;
            // Validity is enforced inside _sweepWithRetry(), which also
            // reconnects and retries when the board resets itself mid-sweep.
            // Anything reaching here has already passed that gate.
            this.onCapture?.(side, fr);

            // Real numbers from the analyser: S/N and latency are the validity gates.
            const d = fr.diagnostics;
            const warn = d.warnings.length
                ? `<div class="result-badge error">${d.warnings.join(' ')}</div>`
                : '';
            const badge = d.warnings.length ? '' : `<div class="result-badge success">${side} measured</div>`;
            document.getElementById('measureResult').innerHTML = `
                ${badge}${warn}
                <div class="result-stats">
                    <div class="stat"><span>Input peak</span><span>${d.inputPeakDb.toFixed(1)} dBFS</span></div>
                    <div class="stat"><span>S/N</span><span>${isFinite(d.snrDb) ? d.snrDb.toFixed(0) + ' dB' : 'n/a'}</span></div>
                    <div class="stat"><span>Loop latency</span><span>${d.latencyMs.toFixed(1)} ms</span></div>
                    <div class="stat"><span>Gate</span><span>${d.gateMs.toFixed(0)} ms</span></div>
                    <div class="stat"><span>Calibrated</span><span>${d.calibrated ? 'yes' : 'no'}</span></div>
                    <div class="stat"><span>Scale</span><span>${
                        d.normalizedAt ? `relative, 0 dB at ${d.normalizedAt} Hz`
                                       : `raw ${d.unit}`}</span></div>
                    <div class="stat"><span>Sample rate</span><span>${capture.sampleRate} Hz</span></div>
                </div>
            `;
            document.getElementById('measureResult').style.display = 'block';
            const sn = isFinite(d.snrDb) ? `S/N ${d.snrDb.toFixed(0)} dB` : 'S/N n/a';
            result = { ok: !d.warnings.length,
                       message: `${sn}, loop latency ${d.latencyMs.toFixed(0)} ms.` + (d.warnings.length ? ' ' + d.warnings.join(' ') : '') };
        } catch (err) {
            document.getElementById('measureResult').innerHTML = `<div class="result-badge error">${err.message}</div>`;
            document.getElementById('measureResult').style.display = 'block';
            result = { ok: false, message: err.message };
        }

        document.getElementById('measureProgress').style.display = 'none';
        buttons.forEach(b => { b.disabled = false; });
        return result;
    }

    // ─── Calibration ──────────────────────────────

    /**
     * Run a sweep and store it as the reference every later measurement is
     * divided by. This is RELATIVE calibration - it removes the microphone,
     * the coupler and the electronics, which is what makes two IEMs
     * comparable on this rig. It is not absolute SPL and does not make the
     * coupler match a published 711 curve.
     */
    async _runCalibration() {
        if (this._refuseOnV4('measureResult')) return;
        const btn = document.getElementById('calibrateBtn');
        // With a substitution calibration loaded this button has no useful job:
        // it can only downgrade dB SPL to a relative curve. Say so rather than
        // doing it.
        if (this.analysis.calibration && this.analysis.calibration.absoluteSpl) {
            const info = document.getElementById('connectInfo');
            if (info) info.innerHTML =
                '<p style="color:var(--ink-dim)">Already calibrated in dB SPL against a ' +
                'known reference measurement. This button performs the older <em>relative</em> ' +
                'calibration, which would replace that and lose the SPL scale, so it is ' +
                'disabled.</p>';
            btn.disabled = true;
            btn.title = 'Absolute calibration already loaded';
            return;
        }
        btn.textContent = 'Calibrating…';
        btn.disabled = true;
        try {
            const capture = await this.engine.playSweep('log', 3, -12, () => {});
            // Store the UNCALIBRATED, UNNORMALISED curve - it has to be the
            // raw rig response or dividing by it removes the wrong thing.
            const fr = this.analysis.extractFR(capture, {
                calibrate: false, normalizeAt: 0,
            });
            this.analysis.setCalibration(fr);
            this.calibration = this.analysis.calibration;
            btn.innerHTML = '&#10003; Calibrated';
        } catch (err) {
            btn.innerHTML = '&#10007; Failed';
            const info = document.getElementById('connectInfo');
            if (info) info.innerHTML =
                `<p style="color:var(--red)">Calibration failed: ${err.message}</p>`;
        }
        setTimeout(() => {
            btn.textContent = 'Calibrate';
            btn.disabled = false;
        }, 3000);
    }

    /** A file name from the studio's entry name. */
    _exportName() {
        return (this.entryName || 'RndB measurement').replace(/[^\w\s.-]/g, '').trim().slice(0, 60) || 'RndB measurement';
    }

    _showMsg(id, text, success) {
        const el = document.getElementById(id);
        el.style.display = 'block';
        el.innerHTML = `<div class="result-badge ${success ? 'success' : 'error'}">${success ? '&#10003;' : '&#10007;'} ${text}</div>`;
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    window.app = new RndBMeasure();
});
