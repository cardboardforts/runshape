import { classComponentId, ComponentWiring, ObjectGraph, ObjectNode, ObjectWire, Run, Scenario } from "@runshape/kernel";

export function buildObjectGraph(scenario: Scenario): ObjectGraph {
  const objects: ObjectNode[] = scenario.objects.map((obj) => ({
    id: obj.id,
    componentId: classComponentId(obj.type),
    className: obj.type.text,
    builtBy: obj.createdIn?.parent?.fn.symbol.localName.text ?? null,
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
        const from = classComponentId(obj.type);
        const to = classComponentId(wire.target.type);
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

