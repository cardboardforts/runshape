// compare.mjs <before.json> <after.json>: which viewer responses changed, by request type, and
// the first few field-level differences. Exits 1 when anything changed.
import { readFileSync } from "node:fs";

const SHOWN_DIFFERENCES = 5;
const FIELDS_PER_DIFFERENCE = 8;

const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));

const labels = [...new Set([...Object.keys(before), ...Object.keys(after)])];
if (labels.length === 0) {
  console.log("view-diff: both dumps are empty; nothing was compared");
  process.exit(2);
}
// A request that throws shows the person nothing, even when it throws the same way on both sides.
const threw = labels.filter((label) => before[label]?.threw !== undefined || after[label]?.threw !== undefined);
for (const label of threw) console.log(`view-diff: threw: ${label}: ${after[label]?.threw ?? before[label]?.threw}`);
const changed = labels.filter((label) => JSON.stringify(before[label]) !== JSON.stringify(after[label]));

if (changed.length === 0) {
  console.log(`view-diff: all ${labels.length} viewer responses identical`);
  process.exit(threw.length > 0 ? 1 : 0);
}

console.log(`view-diff: ${changed.length} of ${labels.length} viewer responses changed`);
const byKind = new Map();
for (const label of changed) {
  const [app, kind] = label.split(" ");
  const key = `${app} ${kind}`;
  byKind.set(key, (byKind.get(key) ?? 0) + 1);
}
for (const [key, count] of [...byKind].sort()) console.log(`  ${String(count).padStart(5)}  ${key}`);

for (const label of changed.slice(0, SHOWN_DIFFERENCES)) {
  console.log(`\n${label}`);
  const fields = [];
  differences(before[label], after[label], "", fields);
  for (const line of fields.slice(0, FIELDS_PER_DIFFERENCE)) console.log(`  ${line}`);
  if (fields.length > FIELDS_PER_DIFFERENCE) console.log(`  … ${fields.length - FIELDS_PER_DIFFERENCE} more`);
}
process.exit(1);

function differences(was, now, path, out) {
  if (JSON.stringify(was) === JSON.stringify(now)) return;
  const bothObjects = was !== null && now !== null && typeof was === "object" && typeof now === "object";
  if (!bothObjects || Array.isArray(was) !== Array.isArray(now)) {
    out.push(`${path || "(response)"}: ${brief(was)} -> ${brief(now)}`);
    return;
  }
  if (Array.isArray(was) && was.length !== now.length) out.push(`${path}: length ${was.length} -> ${now.length}`);
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    differences(was[key], now[key], Array.isArray(was) ? `${path}[${key}]` : `${path}.${key}`, out);
  }
}

function brief(value) {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
