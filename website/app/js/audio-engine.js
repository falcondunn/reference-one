/**
 * RndB Measure — Audio Engine
 * Handles device connection, sweep playback, and recording.
 */
class AudioEngine {
    constructor() {
        this.audioContext = null;
        this.inputDevice = null;
        this.outputDevice = null;
        this.stream = null;
        this.isConnected = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.deviceKind = null;        // 'rev3' | 'v4' | 'other', set by connect()
        this.levelCapDb = null;        // -20 for a V4 (board spec R12), set by connect()
        this.captureChannels = null;   // what the capture track carries
    }

    /**
     * Does this device label look like a Reference One?
     *
     * The board enumerates as a USB Audio Class device, so Windows/macOS name
     * the endpoints from the USB product string: "Headphones (Reference One)"
     * and "Microphone (Reference One)". Labels are only populated AFTER
     * microphone permission is granted - before that they are empty strings,
     * which is why detection has to run post-permission.
     */
    static isReferenceOne(label) {
        const l = (label || '').toLowerCase();
        return l.includes('reference one') || l.includes('rndb') ||
               l.includes('explore');
    }

    /**
     * Which board a label belongs to: 'rev3', 'v4' or 'other'.
     *
     * A V4 has no name of its own. Its codec, the PCM2900C, enumerates as TI's
     * fixed "USB AUDIO CODEC", which every product built on that chip shares
     * (board spec 12.13). So 'v4' means only "could be one": the V4 tab's Check
     * confirms it from the signal. Treating every such device as a V4 is the
     * safe direction - it caps the level and sends the user to that check.
     */
    static deviceKind(label) {
        if (AudioEngine.isReferenceOne(label)) return 'rev3';
        return /usb\s+audio\s+codec/i.test(label || '') ? 'v4' : 'other';
    }

    /**
     * The samples a sweep plays: pure, so it can be tested without a sound card.
     *
     * drive 'both' is the Rev 3's one-channel buffer, which the browser plays on
     * both outputs - unchanged. 'left' and 'right' make a two-channel buffer with
     * the other channel silent: a V4 impedance reading assumes one channel
     * driven (V4 core README).
     *
     * capDb clamps the level, and the level actually played is returned. The V4's
     * cap is -20 dBFS (board spec R12): the Rev 3's level choices go to -8, and
     * its calibration and channel-match sweeps play at -12 and -6, which on a V4
     * in HIGH is about 0.5 V at the jack. A level that is not a number is clamped
     * too, rather than trusted.
     */
    static makeStimulus({ type, duration, level, sampleRate, drive = 'both', capDb = null, freq = null }) {
        const levelDb = (capDb !== null && capDb !== undefined && !(level <= capDb)) ? capDb : level;
        const totalSamples = Math.floor(sampleRate * duration);
        const data = new Float32Array(totalSamples);

        // Generate sweep
        // SWEEP WIDER THAN THE BAND YOU WANT TO MEASURE.
        // A sweep that stops at 20 kHz has almost no energy AT 20 kHz - it only
        // arrives there at the final instant, and from one side - so
        // deconvolution is starved exactly where it is asked for an answer.
        // Measured against a known one-pole filter, the error at 20 kHz was
        // -7.9 dB with a 20-20k sweep and +1.2 dB with this one. The extra
        // span is discarded by the analysis, which still reports 20 Hz-20 kHz.
        const f0 = 10;
        const f1 = Math.min(23500, sampleRate * 0.49);

        if (type === 'log') {
            // Logarithmic chirp
            const T = duration;
            const k = Math.pow(f1 / f0, 1 / T);
            for (let i = 0; i < totalSamples; i++) {
                const t = i / sampleRate;
                const phase = 2 * Math.PI * f0 * (Math.pow(k, t) - 1) / Math.log(k);
                data[i] = Math.sin(phase);
            }
        } else if (type === 'tone') {
            // One frequency, for THD (the V4 tab): its harmonics are what is measured
            if (!(freq > 0 && freq < sampleRate / 2)) {
                throw new Error(`A tone needs a frequency between 0 and ${sampleRate / 2} Hz, not ${freq}`);
            }
            for (let i = 0; i < totalSamples; i++) {
                data[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
            }
        } else {
            // Stepped sine (faster, less accurate at high frequencies)
            const steps = 200;
            const stepDuration = totalSamples / steps;
            for (let step = 0; step < steps; step++) {
                const freq = f0 * Math.pow(f1 / f0, step / (steps - 1));
                const startSample = Math.floor(step * stepDuration);
                const endSample = Math.floor((step + 1) * stepDuration);
                for (let i = startSample; i < endSample && i < totalSamples; i++) {
                    const t = (i - startSample) / sampleRate;
                    data[i] = Math.sin(2 * Math.PI * freq * t);
                }
            }
        }

        // Apply level (convert dB to linear gain)
        const gain = Math.pow(10, levelDb / 20);
        for (let i = 0; i < totalSamples; i++) {
            data[i] *= gain;
        }

        // Apply fade in/out (10ms)
        const fadeSamples = Math.min(Math.floor(sampleRate * 0.01), totalSamples / 4);
        for (let i = 0; i < fadeSamples; i++) {
            const fade = i / fadeSamples;
            data[i] *= fade;
            data[totalSamples - 1 - i] *= fade;
        }

        // KEEP THE EXACT SIGNAL WE PLAY. Deconvolution divides the recording
        // by this, so it must be the post-gain, post-fade samples - not a
        // sweep regenerated afterwards from the same parameters.
        const reference = new Float32Array(data);
        const silent = () => new Float32Array(totalSamples);
        const channels = drive === 'left' ? [data, silent()]
                       : drive === 'right' ? [silent(), data] : [data];
        return { channels, reference, levelDb, totalSamples };
    }

    /** Find the board's input and output endpoints, if present. */
    async findHardware() {
        const { inputs, outputs } = await this.listDevices();
        return {
            input: inputs.find(d => AudioEngine.isReferenceOne(d.label)) || null,
            output: outputs.find(d => AudioEngine.isReferenceOne(d.label)) || null,
            inputs, outputs,
        };
    }

    async listDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter(d => d.kind === 'audioinput');
            const outputs = devices.filter(d => d.kind === 'audiooutput');
            return { inputs, outputs };
        } catch (err) {
            console.warn('Could not enumerate devices:', err);
            return { inputs: [], outputs: [] };
        }
    }

    async requestPermission() {
        try {
            const constraints = {
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000,
                },
                video: false
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            // Stop the stream immediately — we just needed permission
            stream.getTracks().forEach(t => t.stop());
            return true;
        } catch (err) {
            console.warn('Could not get audio permission:', err);
            return false;
        }
    }

    /** The label of a device by id ('default' finds the system default). '' if
     *  it is not listed, or labels are hidden because permission is missing. */
    async _labelOf(kind, id) {
        const { inputs, outputs } = await this.listDevices();
        const d = (kind === 'audioinput' ? inputs : outputs).find(x => x.deviceId === (id || 'default'));
        return d ? d.label || '' : '';
    }

    /** Spec 12.4: a V4 that is the system's default output plays every app's sound, uncapped.
     *  Windows often makes a newly plugged USB audio device the default. */
    async defaultOutputIsV4() {
        return AudioEngine.deviceKind(await this._labelOf('audiooutput', 'default')) === 'v4';
    }

    /** How many devices are named TI's "USB AUDIO CODEC": every product on the V4's chip
     *  shares the name, so with two the V4 cannot be told apart by name. Windows' "default"
     *  and "communications" entries repeat a device and are skipped; inputs and outputs are
     *  counted apart and the larger count taken, so one V4 counts once. 0 without permission. */
    async codecDeviceCount() {
        const { inputs, outputs } = await this.listDevices();
        const count = list => list.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications'
                                            && AudioEngine.deviceKind(d.label) === 'v4').length;
        return Math.max(count(inputs), count(outputs));
    }

    async connect(inputId, outputId) {
        try {
            // A V4 records two channels - the earphone's voltage or the mic, and
            // its current - and Chrome can hand a stereo device over as one
            // unless two are asked for. Only a V4 is asked: anything else keeps
            // the capture it always had.
            const wantsTwo = AudioEngine.deviceKind(await this._labelOf('audioinput', inputId)) === 'v4';

            // Request specific device
            const constraints = {
                audio: {
                    deviceId: inputId ? { exact: inputId } : undefined,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000,
                    ...(wantsTwo ? { channelCount: { ideal: 2 } } : {}),
                },
                video: false
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);

            // THE V4'S LEVEL CAP. What matters is what plays THROUGH a V4, so
            // either end counts - including the system default output, which is
            // where the sweep goes when no output is chosen. Decided after
            // getUserMedia, when the labels are certain to be visible.
            const inKind = AudioEngine.deviceKind(await this._labelOf('audioinput', inputId));
            const outKind = AudioEngine.deviceKind(await this._labelOf('audiooutput', outputId));
            this.deviceKind = inKind === 'v4' || outKind === 'v4' ? 'v4' : inKind;
            this.levelCapDb = this.deviceKind === 'v4' ? -20 : null;
            const settings = this.stream.getAudioTracks()[0]?.getSettings?.() || {};
            this.captureChannels = settings.channelCount || null;

            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000,
            });

            // Create input from stream
            this.inputDevice = this.audioContext.createMediaStreamSource(this.stream);

            // ROUTE THE OUTPUT TO THE CHOSEN DEVICE.
            //
            // This used to be hardcoded to audioContext.destination - the system
            // default. The UI collected an output choice and then threw it away,
            // so a measurement would play the sweep out of the laptop speakers
            // while the board's microphone listened. That does not fail loudly;
            // it silently measures the room instead of the earphone.
            //
            // setSinkId on AudioContext is Chrome 110+. Where it is missing we
            // cannot route, and the caller is told so rather than left to
            // assume the routing worked.
            this.outputDevice = this.audioContext.destination;
            this.outputRouted = false;
            this.outputRouteError = null;
            if (outputId) {
                if (typeof this.audioContext.setSinkId === 'function') {
                    try {
                        await this.audioContext.setSinkId(outputId);
                        this.outputRouted = true;
                    } catch (err) {
                        this.outputRouteError = err.message || String(err);
                    }
                } else {
                    this.outputRouteError =
                        'This browser cannot choose an audio output ' +
                        '(AudioContext.setSinkId unsupported). Use Chrome or Edge' +
                        (this.deviceKind === 'v4'
                            ? ". Here the sweep plays on the system's default output, and a V4 made the default " +
                              "plays every app's sound too, uncapped: switch it back after measuring."
                            : ', or set the Reference One as your system default output.');
                }
            }

            this.isConnected = true;
            const track = this.stream.getAudioTracks()[0];
            const label = (track?.label || '').toLowerCase();
            this._dispatch('connected', {
                sampleRate: this.audioContext.sampleRate,
                inputId: inputId,
                isExplore: label.includes('explore'),
                deviceKind: this.deviceKind,
                levelCapDb: this.levelCapDb,
            });

            return true;
        } catch (err) {
            console.error('Connection failed:', err);
            this.disconnect();
            return false;
        }
    }

    disconnect() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.inputDevice = null;
        this.outputDevice = null;
        this.isConnected = false;
        this._dispatch('disconnected');
    }

    /**
     * Play one sweep and capture both input channels.
     *
     * opts.drive: 'both' (default, the Rev 3's sweep, unchanged), 'left' or
     * 'right' (a V4 drives one channel at a time). The level is clamped to
     * this.levelCapDb, which connect() sets for a V4; the capture reports the
     * level it actually played.
     */
    async playSweep(type, duration, level, onProgress, opts = {}) {
        if (!this.audioContext || !this.isConnected) {
            throw new Error('Not connected');
        }

        const ctx = this.audioContext;
        const sampleRate = ctx.sampleRate;
        const st = AudioEngine.makeStimulus({
            type, duration, level, sampleRate, drive: opts.drive || 'both', capDb: this.levelCapDb, freq: opts.freq,
        });
        const buffer = ctx.createBuffer(st.channels.length, st.totalSamples, sampleRate);
        st.channels.forEach((ch, i) => buffer.getChannelData(i).set(ch));
        const reference = st.reference;

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        await this._startRecording();

        // Start slightly late so capture is definitely running first. The
        // leading silence costs nothing - deconvolution locates the sweep by
        // the impulse-response peak, which is also how latency is measured.
        // A context the browser suspended (a sleep, a device change) plays nothing
        // until resumed; if it cannot resume, the watchdog below still settles this.
        if (ctx.state && ctx.state !== 'running') ctx.resume().catch(() => {});
        const t0 = ctx.currentTime + 0.05;
        source.start(t0);

        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                const pct = Math.max(0, Math.min(100,
                    ((ctx.currentTime - t0) / duration) * 100));
                if (onProgress) onProgress(pct);
            }, 50);
            // A sweep that never ends (a device that went away) must not hang its
            // caller, which holds every button until it returns.
            const watchdog = setTimeout(() => {
                clearInterval(interval);
                this._stopRecording().catch(() => {});
                reject(new Error(`The sweep never finished (the audio is ${ctx.state}): the device ` +
                                 'may have changed. Reconnect it in the Connect tab.'));
            }, (duration + 3) * 1000);

            source.onended = async () => {
                clearTimeout(watchdog);
                clearInterval(interval);
                if (onProgress) onProgress(100);
                try {
                    // Keep recording past the end of the sweep, or the tail of
                    // the impulse response is truncated and the low end with it.
                    await new Promise(r => setTimeout(r, 250));
                    await this._stopRecording();
                    const recording = this._getRecordedData();
                    if (!recording || recording.length < sampleRate * 0.1) {
                        throw new Error(
                            'Almost nothing was captured. Check that the Reference ' +
                            'One is selected as the INPUT device and that the page ' +
                            'has microphone permission.');
                    }
                    // recording2 is the second input channel: a V4's current.
                    // A mono source arrives as two copies, so `channels` says
                    // what the track really carried.
                    resolve({ recording, recording2: this._getRecordedData(this.captured2),
                              channels: this.captureChannels, reference, sampleRate, duration,
                              sweepType: type, levelDb: st.levelDb, drive: opts.drive || 'both' });
                } catch (err) {
                    reject(err);
                }
            };
        });
    }

    // =======================================================================
    // Raw sample capture
    //
    // This used to be MediaRecorder with 'audio/webm;codecs=opus'. Opus is a
    // PERCEPTUAL codec: it discards what it judges inaudible, reshapes noise,
    // and applies its own band limiting. It is an excellent way to store
    // speech and a completely invalid way to measure a transducer - the thing
    // being measured is exactly the thing the codec is licensed to alter.
    //
    // So capture is raw float samples straight off the audio graph. Preferred
    // path is an AudioWorklet, which runs on the audio render thread and
    // cannot be starved by main-thread work; ScriptProcessor is the fallback
    // for browsers without it.
    // =======================================================================

    async _startRecording() {
        if (!this.stream) return;
        this.captured = [];
        this.captured2 = [];
        const ctx = this.audioContext;
        const src = ctx.createMediaStreamSource(this.stream);
        this._capSource = src;

        // A node only runs if it is connected to the destination, so route it
        // through a silent gain - otherwise the graph never pulls it and we
        // capture nothing at all.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        mute.connect(ctx.destination);
        this._capMute = mute;

        if (ctx.audioWorklet && !this._workletFailed) {
            try {
                // A processor is registered PER AudioContext, and every
                // reconnect makes a new one. This used to be a flag on the
                // engine, so after the first board reset the new context had no
                // processor, the node threw, and capture fell back to the
                // ScriptProcessor for the rest of the session - the main-thread
                // path this one exists to avoid.
                if (this._workletCtx !== ctx) {
                    // Both channels: a V4 records its current on the second.
                    // A mono source is up-mixed, so channel 0 is what it was.
                    const code = `
                        class RndbCapture extends AudioWorkletProcessor {
                            process(inputs) {
                                const inp = inputs[0];
                                if (inp && inp[0] && inp[0].length)
                                    this.port.postMessage([inp[0].slice(0), (inp[1] || inp[0]).slice(0)]);
                                return true;
                            }
                        }
                        registerProcessor('rndb-capture', RndbCapture);`;
                    const url = URL.createObjectURL(
                        new Blob([code], { type: 'application/javascript' }));
                    await ctx.audioWorklet.addModule(url);
                    URL.revokeObjectURL(url);
                    this._workletCtx = ctx;
                }
                const node = new AudioWorkletNode(ctx, 'rndb-capture',
                    { channelCount: 2, channelCountMode: 'explicit' });
                node.port.onmessage = (e) => {
                    this.captured.push(e.data[0]);
                    this.captured2.push(e.data[1]);
                };
                src.connect(node);
                node.connect(mute);
                this._capNode = node;
                return;
            } catch (e) {
                console.warn('AudioWorklet capture unavailable, falling back:', e);
                this._workletFailed = true;
            }
        }

        // Two inputs only for a V4: anything else keeps the one-channel
        // down-mix this path always took.
        const nIn = this.deviceKind === 'v4' ? 2 : 1;
        const sp = ctx.createScriptProcessor(4096, nIn, 1);
        sp.onaudioprocess = (e) => {
            const b = e.inputBuffer;
            this.captured.push(new Float32Array(b.getChannelData(0)));
            this.captured2.push(new Float32Array(b.getChannelData(b.numberOfChannels > 1 ? 1 : 0)));
        };
        src.connect(sp);
        sp.connect(mute);
        this._capNode = sp;
    }

    async _stopRecording() {
        try { this._capSource && this._capSource.disconnect(); } catch {}
        try { this._capNode && this._capNode.disconnect(); } catch {}
        try { this._capMute && this._capMute.disconnect(); } catch {}
        if (this._capNode && this._capNode.port) this._capNode.port.onmessage = null;
        if (this._capNode) this._capNode.onaudioprocess = null;
        this._capSource = this._capNode = this._capMute = null;
    }

    /** Flatten the captured blocks into one contiguous Float32Array: channel 0,
     *  unless another channel's blocks are given. */
    _getRecordedData(blocks = this.captured) {
        blocks = blocks || [];
        let n = 0;
        for (const b of blocks) n += b.length;
        if (!n) return null;
        const out = new Float32Array(n);
        let o = 0;
        for (const b of blocks) { out.set(b, o); o += b.length; }
        return out;
    }

    _dispatch(event, detail) {
        document.dispatchEvent(new CustomEvent('audio:' + event, { detail }));
    }

    /**
     * Detect whether any connected audio device is an RndB product.
     * Matches known RndB USB VID/PID or device name patterns.
     */
    async detectRndBDevice() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            // NOT 'usb audio' - that is the generic name Windows gives any
            // class-compliant device, so it matches webcams and headsets too.
            const patterns = ['rndb', 'reference one', 'explore', '1209:0001'];
            for (const dev of devices) {
                const name = (dev.label || '').toLowerCase();
                if (patterns.some(p => name.includes(p))) {
                    return { kind: dev.kind, deviceId: dev.deviceId, label: dev.label };
                }
            }
            return null;
        } catch { return null; }
    }

    /** Check if the currently connected device is RndB-branded. */
    get isRndBDevice() {
        if (!this.stream) return false;
        const track = this.stream.getAudioTracks()[0];
        if (!track) return false;
        const label = (track.label || '').toLowerCase();
        return ['rndb', 'explore', 'reference one'].some(p => label.includes(p));
    }
}
