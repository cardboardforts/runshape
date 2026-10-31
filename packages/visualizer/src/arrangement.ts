// Where a person put the boxes: the arrangement file, read only by the visualizer. Kept per
// zoom level and style (zoomLevelKey), and per box by its name, not its id or position in a
// list, so it survives between recordings and diffs. The app loads and saves the text.
import { FlatPoint, GraphEdge, Layout, LayoutNode, zoomLevelKey } from "@runshape/kernel";

/** On the 3D floor only x and z are a person's: the elevation is the zone's (a terrace). */
export interface FloorSpot {
  x: number;
  z: number;
}

export interface ArrangedLevel {
  flat: Record<string, FlatPoint>;
  floor: Record<string, FloorSpot>;
}

export interface Arrangement {
  /** By zoomLevelKey: "modules@hexagonal", "module:packages.trace@layered", … */
  levels: Record<string, ArrangedLevel>;
}

/** One box moved, in one of the two views. */
export type BoxMove = { node: string; flat: FlatPoint } | { node: string; floor: FloorSpot };

const FORMAT = "runshape-arrangement";
const VERSION = 1;

/**
 * The file can come from anywhere a checkout does, so it's read as untrusted: at most this many
 * levels and spots (a real arrangement has a few levels of tens of boxes), coordinates within
 * this range (beyond it a box is nowhere anyone will scroll to, and sums of them stay exact),
 * and no key that names an object's own machinery.
 */
export const MAX_ARRANGED_LEVELS = 500;
export const MAX_ARRANGED_SPOTS = 20_000;
export const MAX_COORDINATE = 1_000_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Names from the file are quoted back this long at most. */
const MAX_QUOTED = 60;

export class ArrangementError extends Error {}

export function emptyArrangement(): Arrangement {
  return { levels: table() };
}

/** A lookup table with no prototype: a box named "constructor" finds its own spot or none, never Object's. */
function table<T>(entries: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

const clamp = (value: number) => Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, value));

/** A box's name in the file: its code's name, or its id for boxes code doesn't name (client, externals). */
export function boxName(node: Pick<LayoutNode, "id" | "qualifiedName">): string {
  return node.qualifiedName ?? node.id;
}

/**
 * The arrangement after one move. Every box the person can see at that level is written down
 * where it stands now, not just the one moved: the rest were placed by the layout, which can
 * place them elsewhere next time, and the person arranged the moved box against them. A box
 * already saved keeps its saved spot (the layout passed in may predate an earlier move), and
 * boxes not drawn now (another phase, capped) keep theirs too.
 */
export function arrangeBox(arrangement: Arrangement, layout: Layout, move: BoxMove): Arrangement {
  const key = zoomLevelKey(layout.level, layout.profile.style);
  const moved = layout.nodes.find((node) => node.id === move.node);
  if (moved === undefined) throw new ArrangementError(`no box ${move.node} at this level`);
  const level = Object.hasOwn(arrangement.levels, key) ? arrangement.levels[key]! : { flat: table<FlatPoint>(), floor: table<FloorSpot>() };
  const next: ArrangedLevel = { flat: table(level.flat), floor: table(level.floor) };
  if ("flat" in move) {
    for (const node of layout.nodes) next.flat[boxName(node)] ??= { x: clamp(node.flat.x), y: clamp(node.flat.y) };
    next.flat[boxName(moved)] = { x: clamp(move.flat.x), y: clamp(move.flat.y) };
  } else {
    for (const node of layout.nodes) next.floor[boxName(node)] ??= { x: clamp(node.floor.x), z: clamp(node.floor.z) };
    next.floor[boxName(moved)] = { x: clamp(move.floor.x), z: clamp(move.floor.z) };
  }
  return { levels: table({ ...arrangement.levels, [key]: next }) };
}

/** A box's footprint, for finding a free spot: the 2D box, or the 3D tile seen from above. */
export interface Footprint {
  width: number;
  height: number;
}

/**
 * Puts the saved spots back, in one view (2D or 3D). Boxes the person arranged go where they
 * put them. A box new since (not in the saved level) goes beside the arranged boxes it calls or
 * is called by, at their middle or the nearest free spot around it, so it shows up where its
 * work is rather than wherever the layout's own frame happens to put it. A new box with no
 * arranged neighbour starts from where the layout put it, moved off anything it lands on.
 * No saved level: every box stays where the layout put it.
 */
export function applyArrangement<P extends { x: number; y: number }>(
  nodes: LayoutNode[],
  edges: GraphEdge[],
  saved: Record<string, P> | undefined,
  spotOf: (node: LayoutNode) => P,
  place: (node: LayoutNode, spot: P, how: "arranged" | "near-neighbours" | "computed") => LayoutNode,
  footprint: (node: LayoutNode) => Footprint,
): LayoutNode[] {
  if (saved === undefined || Object.keys(saved).length === 0) return nodes;
  const placed = new Map<string, P>();
  for (const node of nodes) {
    const name = boxName(node);
    if (Object.hasOwn(saved, name)) placed.set(node.id, saved[name]!);
  }
  const arranged = new Set(placed.keys());
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const how = new Map<string, "arranged" | "near-neighbours" | "computed">();
  for (const id of arranged) how.set(id, "arranged");
  // In the order the layout lists them, so the same new boxes land the same way every time.
  for (const node of nodes) {
    if (placed.has(node.id)) continue;
    const near = (neighbours.get(node.id) ?? []).filter((id) => arranged.has(id)).map((id) => placed.get(id)!);
    const anchor = near.length > 0 ? centre(near, spotOf(node)) : spotOf(node);
    const taken = [...placed.entries()].map(([id, spot]) => ({ spot, size: footprint(byId.get(id)!) }));
    placed.set(node.id, freeSpot(anchor, footprint(node), taken));
    how.set(node.id, near.length > 0 ? "near-neighbours" : "computed");
  }
  return nodes.map((node) => place(node, placed.get(node.id)!, how.get(node.id)!));
}

/** The middle of some spots, keeping the other fields (a floor tile's elevation) from `like`. */
function centre<P extends { x: number; y: number }>(spots: P[], like: P): P {
  return { ...like, x: spots.reduce((sum, spot) => sum + spot.x, 0) / spots.length, y: spots.reduce((sum, spot) => sum + spot.y, 0) / spots.length };
}

/** Rings around the anchor this far apart (in footprints), and how many rings to try. */
const SEARCH_RINGS = 12;

/** The anchor if nothing's there, else the nearest spot on rings around it that's clear of every placed box. */
function freeSpot<P extends { x: number; y: number }>(anchor: P, size: Footprint, taken: { spot: { x: number; y: number }; size: Footprint }[]): P {
  const clear = (x: number, y: number) =>
    taken.every(({ spot, size: other }) => Math.abs(spot.x - x) >= (size.width + other.width) / 2 || Math.abs(spot.y - y) >= (size.height + other.height) / 2);
  if (clear(anchor.x, anchor.y)) return anchor;
  for (let ring = 1; ring <= SEARCH_RINGS; ring += 1) {
    // Below, above, then the sides: a new box reads best under or over what it works with.
    const candidates: [number, number][] = [];
    for (let dx = -ring; dx <= ring; dx += 1) candidates.push([dx, ring], [dx, -ring]);
    for (let dy = -ring + 1; dy <= ring - 1; dy += 1) candidates.push([ring, dy], [-ring, dy]);
    candidates.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
    for (const [dx, dy] of candidates) {
      const x = anchor.x + dx * size.width;
      const y = anchor.y + dy * size.height;
      if (clear(x, y)) return { ...anchor, x, y };
    }
  }
  return anchor;
}

/** Sorted keys and rounded positions, so a saved file diffs line by line. */
export function serializeArrangement(arrangement: Arrangement): string {
  const levels: Record<string, ArrangedLevel> = {};
  for (const key of Object.keys(arrangement.levels).sort()) {
    const level = arrangement.levels[key]!;
    levels[key] = { flat: sortedSpots(level.flat, (p) => ({ x: round(p.x), y: round(p.y) })), floor: sortedSpots(level.floor, (p) => ({ x: round(p.x), z: round(p.z) })) };
  }
  return `${JSON.stringify({ format: FORMAT, version: VERSION, levels }, null, 2)}\n`;
}

/** Every problem in the file, each with where it is: the file is hand-editable. */
export function parseArrangement(text: string): Arrangement {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // The parser's own message quotes the file: say what's wrong, not what's in it.
    throw new ArrangementError("not JSON");
  }
  const problems: string[] = [];
  if (!isRecord(data)) throw new ArrangementError("not an object");
  if (data.format !== FORMAT) problems.push(`format: expected "${FORMAT}"`);
  if (data.version !== VERSION) problems.push(`version: expected ${VERSION}`);
  const levels = table<ArrangedLevel>();
  const counted = { spots: 0 };
  if (!isRecord(data.levels)) problems.push("levels: expected an object");
  else if (Object.keys(data.levels).length > MAX_ARRANGED_LEVELS) problems.push(`levels: more than ${MAX_ARRANGED_LEVELS}`);
  else {
    for (const [key, level] of Object.entries(data.levels)) {
      if (FORBIDDEN_KEYS.has(key)) {
        problems.push(`levels: a level may not be called ${key}`);
        continue;
      }
      if (!isRecord(level)) {
        problems.push(`levels.${quoted(key)}: expected an object`);
        continue;
      }
      levels[key] = {
        flat: spots<FlatPoint>(level.flat, `levels.${quoted(key)}.flat`, ["x", "y"], problems, counted),
        floor: spots<FloorSpot>(level.floor, `levels.${quoted(key)}.floor`, ["x", "z"], problems, counted),
      };
    }
  }
  if (counted.spots > MAX_ARRANGED_SPOTS) problems.push(`more than ${MAX_ARRANGED_SPOTS} spots`);
  if (problems.length > 0) throw new ArrangementError(problems.slice(0, MAX_PROBLEMS_SAID).join("; ") + (problems.length > MAX_PROBLEMS_SAID ? `; and ${problems.length - MAX_PROBLEMS_SAID} more` : ""));
  return { levels };
}

/** A broken file says its first few problems, not thousands. */
const MAX_PROBLEMS_SAID = 5;

function quoted(name: string): string {
  return name.length > MAX_QUOTED ? `${name.slice(0, MAX_QUOTED)}…` : name;
}

/** The spots under one view of a level, each checked to have exactly its axes as numbers. */
function spots<T>(value: unknown, path: string, axes: string[], problems: string[], counted: { spots: number }): Record<string, T> {
  const result = table<T>();
  if (value === undefined) return result;
  if (!isRecord(value)) {
    problems.push(`${path}: expected an object`);
    return result;
  }
  for (const [name, spot] of Object.entries(value)) {
    counted.spots += 1;
    if (counted.spots > MAX_ARRANGED_SPOTS) return result;
    if (FORBIDDEN_KEYS.has(name)) {
      problems.push(`${path}: a box may not be called ${name}`);
      continue;
    }
    const valid = isRecord(spot) && axes.every((axis) => typeof spot[axis] === "number" && Number.isFinite(spot[axis]));
    if (!valid) problems.push(`${path}.${quoted(name)}: expected ${axes.map((axis) => `"${axis}"`).join(" and ")} as numbers`);
    else result[name] = Object.fromEntries(axes.map((axis) => [axis, clamp(spot[axis] as number)])) as T;
  }
  return result;
}

function sortedSpots<T>(spots: Record<string, T>, rounded: (spot: T) => T): Record<string, T> {
  return Object.fromEntries(Object.keys(spots).sort().map((name) => [name, rounded(spots[name]!)]));
}

/** A tenth of a pixel (or floor unit) is finer than anyone drags. */
const round = (value: number) => Math.round(value * 10) / 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
