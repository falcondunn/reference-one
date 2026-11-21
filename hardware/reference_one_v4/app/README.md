# V4 app core

`v4core.mjs` is spec §12 as pure functions. It has no DOM and no audio APIs, so
`node --test v4core.test.mjs` checks all of it, and the board's pytest suite runs those
tests and compares the core's hardware constants with the placed parts.
`../bench/v4_bench.html` uses it end to end.

## A capture

- 48 kHz, both directions (§12.11), from the device itself (`setSinkId`, and the input by
  `deviceId`). Warn if the V4 has become the system default output (§12.4).
- Raw: no echo cancellation, noise suppression or auto gain. `onGrid16` below 1 means
  the OS changed the data (§12.2).
- Two channels. ch1 is ADC left (the mic in Measure mode, (V_tip + V_ring)/3 in Impedance
  mode). ch2 is ADC right, the earphone current, in both modes.
- **One channel driven at a time** for impedance: the formula assumes it.
- **After a MODE switch, wait 2 s** (spec §8: 1–2 s). The coupling into VINL (1 kΩ + 10 µF into the
  codec's 30 kΩ, τ ≈ 0.31 s) still holds the other position's DC level: a step of about 1.4 V
  (research note) against the ADC's ±1 V, so ch1 clips at first, and the clip check rejects
  the sweep. `detectMode` sees the switch; hold off capturing until the step has settled.
- **Polarity is not assumed.** The output stage inverts (§7), and the codec's datasheet gives no
  polarity for its DAC or ADC. The ratios do not care, because both channels flip together.
  `latency` takes the correlation peak by its size, and the digital twin inverts at the output
  stage. Any alignment the app does itself must also use the size, because an inverted path's
  largest positive value is a side lobe about 600 samples out.

## The order of a measurement

| Step | Function | Spec |
|---|---|---|
| Check every capture | `onGrid16`, `clipCount` per channel (reject on the channels the result uses: THD uses ch1 only, and ch2 clips in HIGH into 8 Ω above −10 dBFS), `channelsDistinct` | 12.1–12.3 |
| Which mode is the switch in? | `detectMode(stim, ch1, ch2)`: never trust the switch | 3 |
| Is it a V4? | `identify(mode, levelDb, nominal)`: the tip channel's level is the signature, within the codec's ±2 dB, or 1 dB of the unit's own read-back. Lower is the host's volume or another device | 12.13 |
| Is the output safe to sweep? | `preflight(ch1Rms, driveRms, allowHigh, nominal)`, in Impedance mode | 7, R14 |
| Channel gain ratio | `calibrateK(ch1, ch2)`, jack empty; factory, and on demand | 8 |
| Channel skew | `calibrateSkew(ch1, ch2)` on a reference plug (a resistor); factory, stored with K | 8, 13.3 |
| Impedance | `impedanceCurve(ch1, ch2, { k, skew, zShort })`; `skew` defaults to the typical 0.33 µs. In NORMAL only: in HIGH it reads 0.6–0.8 Ω high (8 % at 8 Ω), on HIGH's unbalanced sense bridge | 7, 8 |
| Sensitivity, dB SPL/V | `sensitivityCurve(ch1, ch2, zCurve, { k, micDbvPa })`, in Measure mode. Pass the unit's K, and take the mic calibration with the same K | 3 |
| THD | `thdTone(target)` for the frequency, then `thd(x, f0, fs, nHarm, { chainFloorPct })`: at or under the chain's own THD (measured in 13.1) it is `belowChainFloor`, the chain's and not the earphone's | 7, 12.8 |

`detectMode` also returns `levelDb`, the tip voltage per unit of drive, which is what
`preflight` takes: `preflight(10 ** (levelDb / 20), 1)`. It reads the tip channel, not ch1.
- `tipChannel` is ch1 less the sleeve's share on the range's own sense-bridge k (`HW.senseK`),
  so it gives G v / 3, the source voltage, for any load.
- ch1 alone reads 1 + 2 R_s/Z high. On ch1 the pre-flight called every IEM of 16 Ω or less a
  hardware fault.
- On NORMAL's k, a healthy HIGH unit into 8 Ω read 1.4 dB hot.
- Pass the unit's own `nominal` ({ normal, high } in dB) from its calibration file when there is
  one (spec R14). The codec's gain errors (±10 % max each) can move a healthy unit's reading by
  up to 1.8 dB from the design's nominal, and the unit's own read-back cancels them.

## Drift

Nothing here needs play/record re-alignment. The impedance and the sensitivity are
both ratios of ch1 to ch2, which share one ADC clock, so the clock drift cancels (§8,
§12.7). The current channel is the timing reference: `detectMode` takes the bulk
latency from it. `../bench/drift_test.html` measures the drift itself, for the §13.1
go/no-go.

## Noise

At −20 dBFS the current channel is faint: about −72 dBFS with the jack empty, and lower
the higher the load. A Welch H1 estimate (`transfer`) takes its reference channel's noise as
a bias, |H1| = |H| / (1 + N/S), so the ratios are estimated on ch1, which holds near −48 dBFS
for any load: `impedanceCurve` and `calibrateK` call `transfer(ch1, ch2)`. On ch2, K read
2.5 % high and a 300 Ω load 0.9 % low (board spec §8).

- `calibrateK` also sums its bins as cross-spectra in 94 Hz blocks before any magnitude. A
  median of per-bin values scattered 0.3 %, and a coherence gate read 0.1 % high. It leaves
  out the bins within 20 Hz of every 1 kHz: the USB frames' comb sits in both channels at
  once, and adds to the cross-spectrum in every frame.
- One 5 s jack-empty sweep gives K to 0.10 % (1 σ) on the codec's typical noise, and 0.17 %
  on its worst (ADC 81 dB). The scatter falls as one over the root of the length: the bench's
  step 2 sweeps for 20 s, for 0.04 % (0.07 % worst). An on-demand K in the app should do the
  same.
- `simulateCapture(drive, z, { noise: TWIN_NOISE.typical })` adds the codec's noise and its
  16-bit grid. Without it the twin is exact, and that is how the bias hid.
- `sensitivityCurve` keeps ch2: in Measure mode ch1 carries the mic, the fainter of the two
  for most IEMs.
  - On the twin, with the codec's typical noise, it reads within 0.1 dB, 16 to 300 Ω and 100
    to 110 dB SPL/V. On the mic it would read up to 0.5 dB high.
  - On the codec's worst noise, a 100 dB/V earphone at −20 dBFS (60 dB SPL at the mic) loses
    its bins above about 4 kHz to the coherence gate. More sweeps would bring them back.

## The calibration file

Everything per unit that the core takes, where it comes from, and what happens without it.
The app downloads it by serial number (§12.10).

| Field | Per | From | Used by | Without it |
|---|---|---|---|---|
| `k` | channel | `calibrateK`, jack empty (bench step 2, §13.3 item 3) | `impedanceCurve`, `sensitivityCurve` | 1: the ADC channels may differ by 5 % |
| `skew` (s) | channel | `calibrateSkew` on the reference plug (bench step 4, §8) | `impedanceCurve`, `sensitivityCurve` | the typical 0.33 µs: about ±1° left at 20 kHz from the op-amp's GBP spread |
| `nominal` (dB) | channel × range | the full-scale read-back (§13.3 item 1, R14) | `preflight` | the design's: codec gain errors can move a healthy unit up to 1.8 dB |
| mic sensitivity and response | unit | a reference (§13.3 item 4), taken with the same `k` | `sensitivityCurve` (`micDbvPa`), then the app's own curve | the datasheet's −38 dBV/Pa, ±1 dB |
| `chainFloorPct` | level × tone | the chain's own THD (§13.1, §7) | `thd` | only the noise floor: the chain's own harmonics read as the earphone's |

**Version 1** holds the first three, per channel:

```json
{ "format": "reference-one-v4-calibration", "version": 1, "serial": "V4-0001", "date": "2026-10-01T12:00:00.000Z",
  "k": { "L": 1.0012, "R": 0.9987 }, "skew": { "L": 3.34e-7, "R": 3.31e-7 },
  "nominal": { "L": { "normal": -29.06, "high": -9.09 }, "R": { "normal": -29.05, "high": -9.08 } },
  "bench": { "loadOhm": 32 } }
```

- **Written** by the bench page's "Save calibration file" (`calibrationFile` in
  `../bench/v4bench.mjs`), only from steps 2–4 that passed on clean captures, with step 4 on a
  plug of 32 Ω or less.
- **Read** by `calibrationFor(file, "L" | "R")`, which returns `{ k, skew, nominal }` for that
  channel. It refuses the whole file when either channel holds a value no healthy unit gives
  (`CAL`):
  - a read-back more than 2 dB from the design's: the codec's gain errors reach −1.83/+1.66 dB
    (R14);
  - HIGH over NORMAL more than 0.2 dB off the design's 19.97 dB: resistors set it, so a volume
    moved between the read-backs shows there;
  - K outside 0.9–1.1;
  - a skew outside 0.1–1 µs;
  - `simulated`: the bench page's rehearsal mode made it on the digital twin.
- The mic's calibration comes with §13.3 item 4's reference. `chainFloorPct` is the chain's,
  measured once in §13.1, not per unit.
- R14 (decided 2026-10-02): the app passes a unit's `nominal` to `identify` and `preflight`.
  The bench's step 2 keeps the design's +1 dB, so a factory fault never becomes a file's nominal.

A shorted-plug curve (`zShort`, the jack's contact resistance) cannot be taken on a V4. At
−20 dBFS a short leaves ch1 under the noise, and no bin passes the coherence gate. A 0.5–4 Ω
0.1 % plug reads to ±0.5 mΩ, so `zShort` can be that plug's curve less its resistance (spec
12.9). Nothing takes one yet, and 0.05 Ω of contact stays in a reading: +0.6 % at 8 Ω.

## In the measurement app

`website/app` (in the repository since 2026-11-20) drives a V4 since 2026-10-02, from its **V4 tab**. The
design is `docs/superpowers/specs/2026-10-02-website-app-v4-wiring-design.md`. Before the
first edit the app was backed up to `C:/t/backups/website_app_2026-10-02_before_v4`.

- **Level.** `audio-engine.js` caps every sweep at −20 dBFS (spec R12) when either end is a V4:
  its input, its output, or the system default output when none is chosen. That covers the Rev 3
  controls too, which offer up to −8 dBFS and play −12 and −6 on their own.
- **Finding it.** A V4 is TI's generic "USB AUDIO CODEC" (spec 12.13). The Connect tab
  shortlists that name, and the V4 tab's Check confirms it with `identify`.
- **No sweep hangs.** `playSweep` resumes a context the browser suspended (sleep, device
  change), and rejects a sweep that has not ended within its length plus 3 s, telling the user to
  reconnect. The tab holds every button while it waits, so a hang would have locked it.
- **Not the default output (spec 12.4).** Windows often makes a newly plugged USB audio
  device the default, and then every app's sound plays through the V4, uncapped. The V4 tab
  checks after every action (`defaultOutputIsV4`) and warns while it is so.
- **Capture and drive.** Both input channels are captured. A V4 sweep drives one side, from a
  two-channel buffer with the other channel silent.
- **The V4 tab** (`js/v4/v4-session.mjs` holds the logic, `js/v4/v4-panel.mjs` the page).
  - Nothing plays until the user confirms no earphone is in anyone's ear.
  - Check runs `detectMode`, `identify` and `preflight`. Calibrate K needs the jack empty.
  - Impedance L/R uses `impedanceCurve`. Each result states the shared cable-ground bias
    (spec R13, `groundBias`) for g = 0.05–0.2 Ω, over the other side's |Z| once it is measured.
    Response L/R uses `sensitivityCurve`, and needs that side's impedance and the current channel
    holding to 1 dB of it.
  - THD L/R (MODE at MEAS, after that side's response) is a 3.5 s tone near 1 kHz, at -20 dBFS
    in NORMAL. The tone is checked against the side's two sweeps. Its current must hold to
    1 dB, and its ch1/ch2 must match the response's and not the impedance's.
    - A 110 dB/V IEM plays about 70 dB SPL there, where the codec's typical noise bounds THD
      near 0.2 %. It catches a faulty driver, not a good one's fine distortion.
    - HIGH is not offered: the app cannot see where the earphone is.
  - Results go to the Graph and Match tabs. The impedance, which has no tab of its own, leaves
    as **Impedance CSV**: |Z| and phase of each side measured, on the app's 300-point grid. Each
    band takes only its own bins: below ~250 Hz a bin is wider than a band, and a band without
    one has no row rather than its neighbour's value (the plot's fallback).
  - A calibration file loads through `calibrationFor`, from disk or by the unit's serial. By
    serial, the app fetches `data/v4-calibration/v4-calibration-<serial>.json` from its own site
    (spec 12.10): the bench page saves the file under that name, and it is copied there. A file
    whose serial is not the one typed in is refused.
- **Absolute curves on the Graph tab.** A V4 response arrives in dB SPL/V, not normalised, like
  the Rev 3's dB SPL under an absolute calibration. The Graph tab was written for 0 dB at 1 kHz:
  its EQ put every band at −maxGain for such a curve. Now:
  - the EQ reads an absolute or raw curve by its shape;
  - the Target line sits at an absolute curve's 1 kHz level (a raw curve keeps 0 dB, unity gain);
  - an overlay of another kind meets the curve at 1 kHz, while two V4 curves keep their level
    difference;
  - the .txt export writes an absolute level as measured;
  - the CSV button, which had no listener, exports the curve with its unit in the header.

  A relative curve gets byte-identical output to before, checked against the backup.
- **Gaps (NaN bands).** A V4 curve's lowest bands hold no coherent bin, as a Rev 3 curve's do
  outside its calibration. Auto Match counted them, and read "NaN dB, FAIL" for every V4 pair; the
  Match plot lost its deviation line. Now a gap is left out of the figures, the plot lifts the
  pen over it, and smoothing keeps it without blanking the bands beside it. Finite curves give
  byte-identical output, canvas calls included.
- **On a V4, the Rev 3's Measure, Calibrate and Match buttons refuse**, and point to the V4 tab.
  They deconvolve one channel through the Rev 3's own calibration.
- **The Rev 3's path is unchanged.** Its sweep is byte-identical to the old engine's (checked
  against the backup).
- **Caching.** Every asset `index.html` loads carries `?v=<date>` (`.2`, `.3` for later changes
  the same day), and the V4 modules import each other with the same tag. Change anything in
  `css/` or `js/` and bump every tag: a browser that kept an old `audio-engine.js` under the new
  page would play the Rev 3 controls into a V4 uncapped. The V4 tab refuses that engine's
  captures, which report no level, and says to reload.
- **Tests.** `js/v4/v4core.mjs` is a byte-for-byte copy of this file: change it here, then copy
  it across, and `tests/test_website_app.py` fails until it matches. The same test runs the V4
  tab's logic and the engine's cap on the digital twin, and the Graph tab on absolute curves.

## What it cannot do

- **Remove the shared cable-ground bias.** A one-channel reading sits ≈ g/Z_other
  above the plug-referenced value (`groundBias`), and no set of sweeps can separate it
  (`../tests/test_ground_bias.py`). State it with the result. With a detachable
  cable, measure with the other earpiece removed.
- **Calibration download** by serial number (§12.10). That is the app's: see *In the
  measurement app*.
