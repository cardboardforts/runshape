// The layout as an agent reads it (`runshape view --json`): what a person sees at a level, by
// name rather than by id, with test counts instead of every test's id.
import { Change, Layout, ZoomLevel } from "@runshape/kernel";

export interface AgentBox {
  /** The code's name ("packages.trace", "app.db.UsersRepository"), or the box's id when code doesn't name it (the client, externals). */
  name: string;
  label: string;
  kind: string;
  zone: string;
  /** "rule", "inferred" or "fixed", and why. */
  zoneSource: string;
  zoneReason: string;
  calls: number;
  /** How many tests ran through it. */
  tests: number;
  /** Set on a module box: what `--module` opens. */
  opens: string | null;
  /** Comparing: added, removed, changed or unchanged; null otherwise. */
  change: Change | null;
  /** Where it is on the 2D canvas (left to right, or top to bottom for layers), and whether a person put it there. */
  at: { x: number; y: number };
  arranged: boolean;
}

export interface AgentLine {
  from: string;
  to: string;
  calls: number;
  tests: number;
  /** Why the call breaks the style; null when it doesn't. */
  violation: string | null;
  change: Change | null;
}

export interface AgentLevel {
  level: ZoomLevel;
  style: string;
  /** The style's zones in drawing order: the side facing requests first. */
  zones: string[];
  direction: "down" | "right";
  boxes: AgentBox[];
  lines: AgentLine[];
  /** What the cap on detail left out of this level. */
  hidden: Layout["hidden"];
}

/** Boxes in reading order (by position along the flow, then across), so the list reads like the canvas. */
export function layoutForAgents(layout: Layout): AgentLevel {
  const along = (point: { x: number; y: number }) => (layout.direction === "down" ? [point.y, point.x] : [point.x, point.y]);
  const ordered = [...layout.nodes].sort((a, b) => {
    const [a1, a2] = along(a.flat);
    const [b1, b2] = along(b.flat);
    return a1! - b1! || a2! - b2!;
  });
  const nameOf = new Map(layout.nodes.map((node) => [node.id, node.qualifiedName ?? node.id]));
  return {
    level: layout.level,
    style: layout.profile.style,
    zones: layout.profile.zones.map((zone) => zone.id),
    direction: layout.direction,
    boxes: ordered.map((node) => ({
      name: nameOf.get(node.id)!,
      label: node.label,
      kind: node.kind,
      zone: node.zone,
      zoneSource: node.zoneSource,
      zoneReason: node.zoneReason,
      calls: node.calls,
      tests: node.scenarioIds.length,
      opens: node.opens,
      change: node.change,
      at: { x: Math.round(node.flat.x), y: Math.round(node.flat.y) },
      arranged: node.arranged,
    })),
    lines: layout.edges.map((edge) => ({
      from: nameOf.get(edge.from)!,
      to: nameOf.get(edge.to)!,
      calls: edge.calls,
      tests: edge.scenarioIds.length,
      violation: edge.violation,
      change: edge.change,
    })),
    hidden: layout.hidden,
  };
}
