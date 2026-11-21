// Builds the measurement app's data/targets.json from AutoEq's target CSVs (MIT License),
// resampled onto the app's grid (300 log-spaced points, 20 Hz to 20 kHz), 0 dB at 1 kHz.
//   node hardware/reference_one_v4/app/make_app_targets.mjs <AutoEq targets dir> <out.json>
// The dir holds the four CSVs below and AutoEq's LICENSE, whose text goes into the file.
import fs from "node:fs";
import path from "node:path";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error("usage: node make_app_targets.mjs <dir> <out.json>"); process.exit(2); }
const GRID = Array.from({ length: 300 }, (_, i) => 20 * Math.pow(1000, i / 299));
const TARGETS = [
  ["harman-ie-2019", "Harman in-ear 2019", "Harman in-ear 2019.csv"],
  ["harman-ie-2019-nb", "Harman in-ear 2019 without bass", "Harman in-ear 2019 without bass.csv"],
  ["autoeq-ie", "AutoEq in-ear", "AutoEq in-ear.csv"],
  ["df-kemar", "Diffuse field (GRAS KEMAR)", "Diffuse field GRAS KEMAR.csv"],
];
const read = file => fs.readFileSync(path.join(dir, file), "utf8").trim().split(/\r?\n/).slice(1).map(l => l.split(",").map(Number));
const at = (rows, f) => {
  if (f <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++)
    if (rows[i][0] >= f) {
      const t = Math.log(f / rows[i - 1][0]) / Math.log(rows[i][0] / rows[i - 1][0]);
      return rows[i - 1][1] + t * (rows[i][1] - rows[i - 1][1]);
    }
  return rows[rows.length - 1][1];
};
const targets = TARGETS.map(([id, name, file]) => {
  const rows = read(file), ref = at(rows, 1000);
  return { id, name, file, mags: GRID.map(f => Math.round((at(rows, f) - ref) * 100) / 100) };
});
fs.writeFileSync(out, JSON.stringify({
  source: "AutoEq by Jaakko Pasanen, github.com/jaakkopasanen/AutoEq, targets/ (resampled onto this app's grid, 0 dB at 1 kHz)",
  license: fs.readFileSync(path.join(dir, "LICENSE"), "utf8"),
  targets,
}) + "\n");
console.log(`${out}: ${targets.length} targets, ${GRID.length} points each`);
