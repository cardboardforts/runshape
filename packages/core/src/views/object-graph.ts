import { Run, Scenario } from "../model";
import { classComponentId } from "./components";

/**
 * Who holds a reference to whom, as recorded when each object's __init__ finished (the `W`
 * events). For constructor-injected code this is the composition root's wiring diagram,
 * observed rather than read: OrderService#1.repository -> SqlOrderRepository#0.
 */
export interface ObjectNode {
  /** The recording's object id, unique within one scenario. */
  id: number;
  componentId: string;
  className: string;
  /** The function that constructed it, e.g. "compose" or "get_repository.<locals>._get_repo"; null if built outside project code. */
  builtBy: string | null;
  /** When it appeared, in the scenario's microseconds: a replay shows it from then on. */
  seenUs: number;
}

export interface ObjectWire {
  from: number;
  to: number;
  attribute: string;
  /** When the holder's __init__ finished: a replay draws the wire from then on. */
  atUs: number;
}

export interface ObjectGraph {
  scenarioId: string;
  objects: ObjectNode[];
  wires: ObjectWire[];
}

/** Across every scenario: component A's objects hold component B's objects, via these attributes. */
export interface ComponentWiring {
  from: string;
  to: string;
  attributes: string[];
  /** How many object-to-object references were seen, over all scenarios. */
  references: number;
  scenarioIds: string[];
}

export function buildObjectGraph(scenario: Scenario): ObjectGraph {
  const objects: ObjectNode[] = scenario.objects.map((obj) => ({
    id: obj.id,
    componentId: classComponentId(obj.className),
    className: obj.className,
    builtBy: obj.createdIn?.parent?.fn.qualname ?? null,
    seenUs: obj.seenUs,
  }));
  const wires: ObjectWire[] = [];
  for (const obj of scenario.objects) {
    for (const wire of obj.wires) wires.push({ from: obj.id, to: wire.target.id, attribute: wire.attribute, atUs: wire.atUs });
  }
  return { scenarioId: scenario.nodeid, objects, wires };
}

export function aggregateWiring(run: Run): ComponentWiring[] {
  const byPair = new Map<string, { from: string; to: string; attributes: Set<string>; references: number; scenarioIds: Set<string> }>();
  for (const scenario of run.scenarios) {
    for (const obj of scenario.objects) {
      for (const wire of obj.wires) {
        const from = classComponentId(obj.className);
        const to = classComponentId(wire.target.className);
        const key = `${from}->${to}`;
        const entry = byPair.get(key) ?? { from, to, attributes: new Set<string>(), references: 0, scenarioIds: new Set<string>() };
        entry.attributes.add(wire.attribute);
        entry.references += 1;
        entry.scenarioIds.add(scenario.nodeid);
        byPair.set(key, entry);
      }
    }
  }
  return [...byPair.values()]
    .map((entry) => ({
      from: entry.from,
      to: entry.to,
      attributes: [...entry.attributes].sort(),
      references: entry.references,
      scenarioIds: [...entry.scenarioIds].sort(),
    }))
    .sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`));
}

