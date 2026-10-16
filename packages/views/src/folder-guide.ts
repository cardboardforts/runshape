import { Phase, Role, Run } from "@runshape/trace";
import { FINE_GROUPING, ZoneRule, ZoneRules } from "@runshape/architecture";
import { ArchitectureSnapshot, byCodeUnit, Placement } from "./placements";
import { buildSystemGraph } from "./system-graph";

/** One source folder, as its README describes it (folder-guide.test.ts says why). */
export interface FolderGuide {
  /** Relative to the project, "/"-separated; "" for its root. */
  folder: string;
  /** The zone most of its files are in; null when none of them was placed. */
  zone: string | null;
  zoneName: string | null;
  /** The style's zones by id, for showing a file's zones by name. */
  zoneNames: Record<string, string>;
  files: FileGuide[];
  /** What writing the guide raised: code that doesn't fit, mixes kinds, or never ran. */
  questions: string[];
}

export interface FileGuide {
  file: string;
  name: string;
  /** False when nothing in it ran in the recorded tests (a file on disk, or catalogued functions nobody called). */
  seen: boolean;
  /** The recording read it and found no functions: types, re-exports, or a script's top-level code. */
  declarationsOnly: boolean;
  /** The zones of what's in it (its module, its classes), in the style's order. */
  zones: string[];
  classes: { name: string; zone: string; decidedBy: ZoneRule["by"] | null }[];
  /**
   * Its entry points: functions called from outside the file (by other files, or tests), most
   * called first. That's the file's interface as it's used; helpers only it calls stay out.
   */
  functions: { name: string; calls: number }[];
  functionCount: number;
}

/** A file's most-used entry points listed; the rest only counted. */
const MOST_CALLED_SHOWN = 5;
const EVERY_PHASE = [Phase.Setup, Phase.Call, Phase.Teardown];

/**
 * A guide to every folder the recording ran code in. `filesOnDisk` are the project's source
 * files (not tests): those in a guided folder that never ran are listed as not seen running.
 * `rules` should be the ones `snapshot` was placed with, so the calls against the style match.
 */
export function buildFolderGuides(run: Run, snapshot: ArchitectureSnapshot, filesOnDisk: string[], rules: ZoneRules = ZoneRules.none()): FolderGuide[] {
  const placements = new Map(snapshot.placements.map((p) => [p.component, p]));
  const zoneOrder = snapshot.zones.map((z) => z.id);
  const zoneName = (id: string) => snapshot.zones.find((z) => z.id === id)?.name ?? id;
  const calls = callsFromOutside(run);
  const ran = ranFunctions(run);
  const testFiles = filesOfTestCode(run);

  // Each recorded file: its functions, and the components (module, classes) they belong to.
  const recorded = new Map<string, { owners: Set<string>; functions: { name: string; calls: number; ran: boolean }[] }>();
  for (const fn of run.catalog) {
    if (testFiles.has(fn.file) || isTestPath(fn.file)) continue;
    const entry = recorded.get(fn.file) ?? { owners: new Set<string>(), functions: [] };
    recorded.set(fn.file, entry);
    entry.owners.add(fn.symbol.owner.text);
    entry.functions.push({ name: fn.symbol.localName.text, calls: calls.get(fn.symbol.key) ?? 0, ran: ran.has(fn.symbol.key) });
  }
  const fileOf = new Map<string, string>();
  for (const [file, { owners }] of recorded) for (const owner of owners) if (!fileOf.has(owner)) fileOf.set(owner, file);

  const folders = new Map<string, FileGuide[]>();
  for (const [file, { owners, functions }] of recorded) {
    const placed = [...owners].map((owner) => placements.get(owner)).filter((p): p is Placement => p !== undefined);
    const zones = [...new Set(placed.map((p) => p.zone))].sort((a, b) => zoneOrder.indexOf(a) - zoneOrder.indexOf(b));
    const classes = placed
      .filter((p) => p.kind === "class")
      .map((p) => ({ name: lastSegment(p.component), zone: p.zone, decidedBy: p.decidedBy }))
      .sort((a, b) => byCodeUnit(a.name, b.name));
    const ranked = [...functions].sort((a, b) => b.calls - a.calls || byCodeUnit(a.name, b.name));
    // Seen when something in it ran: catalogued functions alone are a file nothing exercised.
    const seen = functions.some((f) => f.ran);
    const entryPoints = ranked.filter((f) => f.calls > 0).slice(0, MOST_CALLED_SHOWN).map(({ name, calls }) => ({ name, calls }));
    const guide: FileGuide = { file, name: baseName(file), seen, declarationsOnly: false, zones, classes, functions: entryPoints, functionCount: functions.length };
    folders.set(folderOf(file), [...(folders.get(folderOf(file)) ?? []), guide]);
  }
  for (const file of filesOnDisk) {
    if (recorded.has(file) || !folders.has(folderOf(file)) || isTestPath(file)) continue;
    // Read by the recorder (its source is kept) yet with no functions catalogued: declarations.
    const declarationsOnly = run.sources?.has(file) ?? false;
    folders.get(folderOf(file))!.push({ file, name: baseName(file), seen: false, declarationsOnly, zones: [], classes: [], functions: [], functionCount: 0 });
  }

  const offStyle = callsAgainstStyle(run, rules, snapshot, fileOf);
  return [...folders]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([folder, files]) => {
      files.sort((a, b) => byCodeUnit(a.name, b.name));
      const zone = dominantZone(files, zoneOrder);
      return { folder, zone, zoneName: zone === null ? null : zoneName(zone), zoneNames: Object.fromEntries(snapshot.zones.map((z) => [z.id, z.name])), files, questions: questionsFor(folder, files, zone, zoneName, placements, recorded, offStyle) };
    });
}

function questionsFor(
  folder: string,
  files: FileGuide[],
  zone: string | null,
  zoneName: (id: string) => string,
  placements: Map<string, Placement>,
  recorded: Map<string, { owners: Set<string> }>,
  offStyle: Map<string, string[]>,
): string[] {
  const questions: string[] = [];
  const where = folder === "" ? "the project's root" : folder;
  for (const file of files) {
    if (file.declarationsOnly) continue;
    if (!file.seen) {
      questions.push(`${file.name} wasn't seen running in the recorded tests: untested, or no longer used?`);
      continue;
    }
    if (file.zones.length > 1) {
      const byZone = file.zones.map((z) => `${zoneName(z)} (${file.classes.filter((c) => c.zone === z).map((c) => c.name).join(", ") || "its module"})`);
      questions.push(`${file.name} holds more than one kind of code: ${byZone.join(" and ")}. Split it?`);
    } else if (file.zones.length === 1 && zone !== null && file.zones[0] !== zone) {
      const reason = [...recorded.get(file.file)!.owners].map((owner) => placements.get(owner)?.reason).find(Boolean);
      questions.push(`${file.name} is ${zoneName(file.zones[0]!)}, unlike the rest of ${where} (${zoneName(zone)})${reason ? `: ${reason}` : ""}. Does it belong here?`);
    }
    for (const call of offStyle.get(file.file) ?? []) questions.push(`${file.name} ${call}`);
  }
  return questions;
}

/** Calls the drawn style forbids, by the calling file: "calls X against the hexagonal style: …". */
function callsAgainstStyle(run: Run, rules: ZoneRules, snapshot: ArchitectureSnapshot, fileOf: Map<string, string>): Map<string, string[]> {
  const graph = buildSystemGraph(run, { phases: EVERY_PHASE, grouping: FINE_GROUPING, rules, profile: rules.profile });
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const found = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.violation === null) continue;
    const from = nodes.get(edge.from);
    const file = from?.qualifiedName ? fileOf.get(from.qualifiedName) : undefined;
    if (file === undefined) continue;
    const line = `calls ${nodes.get(edge.to)?.label ?? edge.to}, against the ${snapshot.style} style: ${edge.violation}`;
    if (!found.get(file)?.includes(line)) found.set(file, [...(found.get(file) ?? []), line]);
  }
  return found;
}

/** The zone most files are in (a file counts once per zone it holds); the style's order breaks a tie. */
function dominantZone(files: FileGuide[], order: string[]): string | null {
  const counts = new Map<string, number>();
  for (const file of files) for (const zone of file.zones) counts.set(zone, (counts.get(zone) ?? 0) + 1);
  let best: string | null = null;
  for (const [zone, count] of counts) {
    const bestCount = best === null ? -1 : counts.get(best)!;
    if (count > bestCount || (count === bestCount && order.indexOf(zone) < order.indexOf(best!))) best = zone;
  }
  return best;
}

/** Files whose code ran as the tests' own: a guide is to the project's code, not its tests. */
function filesOfTestCode(run: Run): Set<string> {
  const files = new Set<string>();
  for (const scenario of run.scenarios) for (const span of scenario.spans) if (span.fn.role === Role.Test && span.fn.file !== null) files.add(span.fn.file);
  return files;
}

/**
 * Test code by its name, in the languages recorded: a test file whose tests weren't among the
 * recorded ones never ran as a test, so its role alone doesn't tell.
 */
export function isTestPath(file: string): boolean {
  const segments = file.split("/");
  const name = segments[segments.length - 1]!;
  return (
    segments.slice(0, -1).some((segment) => TEST_FOLDERS.has(segment)) ||
    /^test_.*\.py$|_test\.py$|^conftest\.py$|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$/.test(name)
  );
}

const TEST_FOLDERS = new Set(["test", "tests", "__tests__", "testdata"]);

/** Calls each function got from another file (or a test, or the framework): its use as an interface. */
function callsFromOutside(run: Run): Map<string, number> {
  const calls = new Map<string, number>();
  for (const scenario of run.scenarios) {
    for (const span of scenario.spans) {
      if (span.parent !== null && span.parent.fn.file === span.fn.file) continue;
      calls.set(span.fn.symbol.key, (calls.get(span.fn.symbol.key) ?? 0) + 1);
    }
  }
  return calls;
}

function ranFunctions(run: Run): Set<string> {
  const keys = new Set<string>();
  for (const scenario of run.scenarios) for (const span of scenario.spans) keys.add(span.fn.symbol.key);
  return keys;
}

function folderOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** The last segment of a dotted name, its escaped dots (Go's example\.com) left as they are. */
function lastSegment(name: string): string {
  const parts = name.split(/(?<!\\)\./);
  return parts[parts.length - 1]!;
}
