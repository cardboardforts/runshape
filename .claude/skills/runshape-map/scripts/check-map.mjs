#!/usr/bin/env node
// The runshape-map skill's deterministic half: reads a project's map (runshape.json's "map"
// section) against its git files and the catalog. Node's standard library only, because it runs
// inside other people's repositories. Prints one JSON report; exits 1 only when the map itself
// can't be trusted. Format: runshape-arch/map-format.md.
//
//   node check-map.mjs [--project <folder>]    the report
//   node check-map.mjs where                   the catalog's folder
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULES_FILE = "runshape.json";
const DECIDERS = ["user", "llm", "detected"];
const STATES = ["parts", "shape", "plain", "dragons", "spaghetti"];
const UNKNOWN_STATES = ["dragons", "spaghetti"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Commits come from a repository's own runshape.json: only hex may reach git, never an option.
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
const GIT_BUFFER_BYTES = 64 * 1024 * 1024;

const decidersText = `"${DECIDERS.slice(0, -1).join('", "')}" or "${DECIDERS.at(-1)}"`;
const statesText = `"${STATES.slice(0, -1).join('", "')}" or "${STATES.at(-1)}"`;

function catalogFolder() {
  // Node resolves a symlinked script to its real path, so this works from ~/.claude/skills too.
  return process.env.RUNSHAPE_ARCH ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../runshape-arch");
}

function git(project, args) {
  return execFileSync("git", args, { cwd: project, encoding: "utf8", maxBuffer: GIT_BUFFER_BYTES, stdio: ["ignore", "pipe", "pipe"] });
}

function projectFiles(project) {
  // Untracked counts: scaffolding is often uncommitted. Ignored files and empty folders don't.
  // runshape.json is excluded: the map's own file isn't code for a system to claim. So are files
  // deleted but not committed: --cached still lists them.
  const names = (args) => git(project, ["ls-files", ...args, "-z"]).split("\0").filter((file) => file !== "");
  const deleted = new Set(names(["--deleted"]));
  const listed = names(["--cached", "--others", "--exclude-standard"]);
  return [...new Set(listed)].filter((file) => file !== RULES_FILE && !deleted.has(file)).sort();
}

function markdownIn(folder) {
  return existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith(".md") && file !== "README.md") : [];
}

function entryIds(folder) {
  return markdownIn(folder).flatMap((file) => [...readFileSync(join(folder, file), "utf8").matchAll(/^### `([a-z0-9-]+)`/gm)].map((match) => match[1]));
}

function readCatalog(folder) {
  const styles = new Map();
  for (const file of markdownIn(join(folder, "styles"))) {
    const text = readFileSync(join(folder, "styles", file), "utf8");
    const id = /^id: (.+)$/m.exec(text)?.[1]?.trim();
    const zones = /^zones: (.+)$/m.exec(text)?.[1]?.split(",").map((zone) => zone.trim());
    if (id !== undefined && zones !== undefined) styles.set(id, zones);
  }
  const shared = /^shared_zones: (.+)$/m.exec(readFileIfThere(join(folder, "styles", "README.md")))?.[1]?.split(",").map((zone) => zone.trim()) ?? [];
  return { styles, shared, roles: new Set(entryIds(join(folder, "roles"))), patterns: new Set(entryIds(join(folder, "patterns"))) };
}

function readFileIfThere(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** `a/b/**` covers everything under a/b, as does a bare `a/b`; `*` stays within one segment. */
function pathMatcher(glob) {
  const escaped = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const segments = glob.replace(/\/+$/, "").split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") source += last ? ".*" : "(?:[^/]+/)*";
    else source += `${escaped(segment).replaceAll("*", "[^/]*")}${last ? "" : "/"}`;
  });
  return new RegExp(glob.includes("*") ? `^${source}$` : `^${source}(?:/.*)?$`);
}

function filesMatching(paths, files) {
  const matchers = paths.filter(isGlob).map(pathMatcher);
  return files.filter((file) => matchers.some((matcher) => matcher.test(file)));
}

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const isGlob = nonEmpty;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

function realDate(text) {
  if (typeof text !== "string" || !ISO_DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

function checkDecider(value, where, problems) {
  if (!DECIDERS.includes(value)) problems.push(`${where} must be ${decidersText}`);
}

/** Flattens the tree to one record per system, reporting everything wrong as it goes. */
function readSystems(systems, parent, whereParent, ctx) {
  const seen = new Set();
  return listOf(systems).flatMap((candidate, index) => {
    const { problems, catalog, files } = ctx;
    if (!isObject(candidate)) {
      problems.push(`${whereParent}systems[${index}] must be an object`);
      return [];
    }
    const label = nonEmpty(candidate.name) ? ` (${candidate.name})` : "";
    const where = `${whereParent}systems[${index}]${label}`;
    if (!nonEmpty(candidate.name)) problems.push(`${where}.name must be a non-empty string`);
    else if (candidate.name.includes("/")) problems.push(`${where}.name can't contain "/": a system's path joins names with it`);
    else if (seen.has(candidate.name)) problems.push(`${where}: the name is already used at this level`);
    seen.add(candidate?.name);
    if (!nonEmpty(candidate?.description)) problems.push(`${where}.description must say what it is for`);
    checkDecider(candidate?.by, `${where}.by`, problems);
    if (candidate?.pathsBy !== undefined) checkDecider(candidate.pathsBy, `${where}.pathsBy`, problems);
    const paths = candidate.paths;
    if (paths !== undefined && !(Array.isArray(paths) && paths.every(isGlob))) problems.push(`${where}.paths must be a list of non-empty globs`);

    const state = candidate?.state;
    const children = listOf(candidate?.systems);
    // No state yet is the interview between questions: reported as undecided, not refused.
    if (state !== undefined && !STATES.includes(state)) problems.push(`${where}.state must be ${statesText}`);
    if (state === "shape" && children.length > 0) problems.push(`${where}: "shape" stops the drill-down, so it has no systems: use "parts"`);
    if (state === "shape" && !catalog.styles.has(candidate?.style)) {
      problems.push(`${where}.style ${JSON.stringify(candidate?.style)} is not in the catalog (${[...catalog.styles.keys()].sort().join(", ")})`);
    }
    if ([...UNKNOWN_STATES, "plain"].includes(state) && candidate?.style !== undefined) problems.push(`${where}: "${state}" takes no style`);
    if (state === "plain" && children.length > 0) problems.push(`${where}: "plain" has nothing inside it: use "parts"`);
    if (UNKNOWN_STATES.includes(state)) {
      if (!nonEmpty(candidate?.marked?.who) || !realDate(candidate?.marked?.on)) problems.push(`${where}.marked must say who and on (YYYY-MM-DD)`);
    }

    const path = parent === null ? String(candidate?.name) : `${parent.path}/${candidate?.name}`;
    const record = { path, parent, paths: listOf(candidate?.paths), state, own: filesMatching(listOf(candidate?.paths), files), children: [] };
    const inner = readSystems(children, record, `${where}.`, ctx);
    record.children = inner.filter((system) => system.parent === record);
    checkShapeDetail(candidate, record, where, ctx);
    return [record, ...inner];
  });
}

function checkShapeDetail(candidate, record, where, { problems, catalog, files }) {
  const zones = [...(catalog.styles.get(candidate?.style) ?? []), ...catalog.shared];
  listOf(candidate?.zones).forEach((entry, index) => {
    const at = `${where}.zones[${index}]`;
    if (catalog.styles.has(candidate?.style) && !zones.includes(entry?.zone)) {
      problems.push(`${at}.zone ${JSON.stringify(entry?.zone)} is not a zone of ${candidate.style} (${catalog.styles.get(candidate.style).join(", ")})`);
    }
    if (!nonEmpty(entry?.reason)) problems.push(`${at}.reason must say why`);
    checkDecider(entry?.by, `${at}.by`, problems);
    checkInsideSystem(entry, record, at, files, problems);
  });
  listOf(candidate?.roles).forEach((entry, index) => {
    const at = `${where}.roles[${index}]`;
    if (!catalog.roles.has(entry?.role)) problems.push(`${at}.role ${JSON.stringify(entry?.role)} is not in the catalog`);
    if (!nonEmpty(entry?.reason)) problems.push(`${at}.reason must say why`);
    checkDecider(entry?.by, `${at}.by`, problems);
    checkInsideSystem(entry, record, at, files, problems);
  });
}

function checkInsideSystem(entry, record, at, files, problems) {
  const owned = new Set(record.own);
  const matched = filesMatching(listOf(entry?.paths), files);
  if (matched.length === 0 || matched.some((file) => !owned.has(file))) problems.push(`${at}.paths match no code in this system`);
}

/** Files a system covers: its own paths, or, for a plain box, whatever its parts cover. */
function covered(system) {
  return new Set([...system.own, ...system.children.flatMap((child) => [...covered(child)])]);
}

function claimsTwice(systems) {
  // A parent and its own part claiming a file is drilling down. Cousins claiming one isn't.
  const related = (a, b) => a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`);
  const claimants = new Map();
  for (const system of systems) {
    for (const file of system.own) claimants.set(file, [...(claimants.get(file) ?? []), system]);
  }
  const twice = [];
  for (const [file, holders] of claimants) {
    const unrelated = holders.filter((holder) => holders.some((other) => other !== holder && !related(holder, other)));
    if (unrelated.length > 1) twice.push({ file, systems: unrelated.map((holder) => holder.path).sort() });
  }
  return twice.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** Unclaimed files as the highest folders nothing in them is claimed: "lab/ (2 files)". */
function grouped(remaining, files) {
  const left = new Set(remaining);
  const claimed = files.filter((file) => !left.has(file));
  const folderOf = (file) => {
    const segments = file.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const folder = `${segments.slice(0, depth).join("/")}/`;
      if (!claimed.some((other) => other.startsWith(folder))) return folder;
    }
    return file;
  };
  const groups = new Map();
  for (const file of remaining) {
    const key = folderOf(file);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, count]) => (key.endsWith("/") ? `${key} (${count} ${count === 1 ? "file" : "files"})` : key));
}

function unclaimed(files, systems) {
  const roots = systems.filter((system) => system.parent === null);
  const claimedAtTop = new Set(roots.flatMap((system) => [...covered(system)]));
  const left = [];
  const report = (within, remaining) => {
    if (remaining.length > 0) left.push({ within, files: remaining.length, groups: grouped(remaining, files) });
  };
  report(null, files.filter((file) => !claimedAtTop.has(file)));
  for (const system of systems) {
    if (system.children.length === 0) continue;
    const claimedInside = new Set(system.children.flatMap((child) => [...covered(child)]));
    report(system.path, system.own.filter((file) => !claimedInside.has(file)));
  }
  return left;
}

function checkExpects(expects, systems, problems) {
  if (expects !== undefined && !Array.isArray(expects)) problems.push("expects must be a list");
  const known = new Set(systems.map((system) => system.path));
  listOf(expects).forEach((entry, index) => {
    const at = `expects[${index}]`;
    for (const end of ["from", "to"]) {
      if (!known.has(entry?.[end])) problems.push(`${at}.${end} ${JSON.stringify(entry?.[end])} is not a system`);
    }
    if (typeof entry?.talks !== "boolean") problems.push(`${at}.talks must be true or false`);
    if (!nonEmpty(entry?.reason)) problems.push(`${at}.reason must say why`);
    checkDecider(entry?.by, `${at}.by`, problems);
  });
}

function checkExceptions(exceptions, problems) {
  if (exceptions !== undefined && !Array.isArray(exceptions)) problems.push("exceptions must be a list");
  listOf(exceptions).forEach((entry, index) => {
    const at = `exceptions[${index}]`;
    if (!nonEmpty(entry?.claim)) problems.push(`${at}.claim must say what doesn't hold`);
    if (!nonEmpty(entry?.reason)) problems.push(`${at}.reason must say why`);
    checkDecider(entry?.by, `${at}.by`, problems);
  });
}

/** How many lines `file` had at `commit`, or null when that commit doesn't have it. */
function linesAt(project, commit, file) {
  try {
    const text = git(project, ["cat-file", "blob", `${commit}:${file}`]);
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return null;
  }
}

function checkPart(part, at, project, problems) {
  if (!nonEmpty(part?.part)) problems.push(`${at}.part must name the part`);
  if (!nonEmpty(part?.file)) problems.push(`${at}.file must be a path from the project root`);
  if (part?.lines === undefined) return;
  const lines = part.lines;
  const wellFormed = Array.isArray(lines) && lines.length === 2 && Number.isInteger(lines[0]) && Number.isInteger(lines[1]) && lines[0] >= 1 && lines[0] <= lines[1];
  if (!nonEmpty(part.commit)) problems.push(`${at}.lines need the commit they were tagged at`);
  else if (!COMMIT_SHA.test(part.commit)) problems.push(`${at}.commit must be a commit's hex sha`);
  else if (!wellFormed) problems.push(`${at}.lines must be [first, last], counting from 1`);
  else {
    const length = linesAt(project, part.commit, part.file);
    if (length === null) problems.push(`${at}.commit ${part.commit} has no ${part.file}`);
    else if (lines[1] > length) problems.push(`${at}.lines run past the ${length} lines ${part.file} had at that commit`);
  }
}

function checkPatterns(patterns, catalog, project, problems) {
  if (patterns !== undefined && !Array.isArray(patterns)) problems.push("patterns must be a list");
  listOf(patterns).forEach((entry, index) => {
    const label = nonEmpty(entry?.name) ? ` (${entry.name})` : "";
    const at = `patterns[${index}]${label}`;
    if (!nonEmpty(entry?.name)) problems.push(`${at}.name must be a non-empty string`);
    if (entry?.catalog !== undefined && entry.catalog !== null && !catalog.patterns.has(entry.catalog)) {
      problems.push(`${at}.catalog ${JSON.stringify(entry.catalog)} is not in the catalog: use a catalog id, or null for a name of your own`);
    }
    checkDecider(entry?.by, `${at}.by`, problems);
    const parts = listOf(entry?.parts);
    if (parts.length === 0) problems.push(`${at}.parts must list at least one part`);
    parts.forEach((part, partIndex) => checkPart(part, `${at}.parts[${partIndex}]`, project, problems));
  });
}

function emptyReport(catalog, files, problems) {
  return { catalog, files, problems, unclaimed: [], claimedTwice: [], noCode: [], undecided: [], states: { parts: 0, shape: 0, plain: 0, dragons: 0, spaghetti: 0 }, patterns: 0 };
}

function report(project) {
  const folder = catalogFolder();
  let files;
  try {
    files = projectFiles(project);
  } catch (error) {
    return emptyReport(folder, 0, [`not a git repository: git says ${String(error.stderr ?? error.message).trim()}`]);
  }
  if (!existsSync(folder)) return emptyReport(folder, files.length, [`no catalog at ${folder}: set RUNSHAPE_ARCH to the runshape-arch folder`]);

  let map = null;
  const rulesPath = join(project, RULES_FILE);
  if (existsSync(rulesPath)) {
    try {
      const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
      if (!isObject(rules)) return emptyReport(folder, files.length, [`${RULES_FILE} must be an object`]);
      map = rules.map ?? null;
    } catch (error) {
      return emptyReport(folder, files.length, [`${RULES_FILE} is not JSON: ${error.message}`]);
    }
  }
  if (map !== null && !isObject(map)) return emptyReport(folder, files.length, ["map must be an object"]);

  const problems = [];
  if (map?.systems !== undefined && !Array.isArray(map.systems)) problems.push("systems must be a list");
  const catalog = readCatalog(folder);
  const systems = readSystems(map?.systems, null, "", { problems, catalog, files });
  checkExpects(map?.expects, systems, problems);
  checkExceptions(map?.exceptions, problems);
  checkPatterns(map?.patterns, catalog, project, problems);

  const states = { parts: 0, shape: 0, plain: 0, dragons: 0, spaghetti: 0 };
  for (const system of systems) if (system.state in states) states[system.state] += 1;
  return {
    catalog: folder,
    files: files.length,
    problems,
    unclaimed: unclaimed(files, systems),
    claimedTwice: claimsTwice(systems),
    noCode: systems.filter((system) => covered(system).size === 0).map((system) => system.path).sort(),
    undecided: systems.filter((system) => system.state === undefined || (system.state === "parts" && system.children.length === 0)).map((system) => system.path).sort(),
    states,
    patterns: listOf(map?.patterns).length,
  };
}

const args = process.argv.slice(2);
if (args[0] === "where") {
  console.log(catalogFolder());
} else {
  const at = args.indexOf("--project");
  const named = at !== -1 && args[at + 1] !== undefined;
  const result = at !== -1 && !named ? emptyReport(catalogFolder(), 0, ["--project needs a folder"]) : report(resolve(named ? args[at + 1] : "."));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.problems.length > 0 ? 1 : 0;
}
