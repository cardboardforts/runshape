/**
 * A style's own zones are coloured by position, not by name: whatever faces the requests is
 * blue, the middle green, the side facing out amber. That keeps the hexagon's original
 * colours and lets a new style render without a palette of its own. Fixed zones (framework,
 * test doubles, externals) look the same in every style.
 */
import { describe, expect, test } from "vitest";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ArchitectureProfile, ArchitectureStyle, FixedZone, Phase, TraceDirectory } from "@runshape/kernel";
import { ViewerSession } from "@runshape/workflows";

import { zoneClass, zoneColor, zoneLabel } from "../src/zone-style";

/** The style as the viewer gets it: the profile a layout drawn in it carries. */
async function profileOf(style: ArchitectureStyle): Promise<ArchitectureProfile> {
  const fixtures = join(import.meta.dirname, "..", "..", "kernel", "test", "fixtures", "fastapi");
  const run = await new TraceDirectory({ readText: (path) => readFile(join(fixtures, path), "utf8") }).latest();
  const response = await new ViewerSession(run, { sources: { readLines: async () => null } }).handle({ type: "graph", phases: [Phase.Call], grouping: { collapseMiddleware: true }, style });
  if (response?.type !== "graph") throw new Error(`expected a layout, got ${JSON.stringify(response)}`);
  return response.layout.profile;
}

async function table(style: ArchitectureStyle): Promise<string[]> {
  const profile = await profileOf(style);
  const zones = [...profile.zones.map((zone) => zone.id), ...Object.values(FixedZone), "a-zone-of-another-style"];
  return zones.map((zone) => `${zone.padEnd(24)}${zoneClass(profile, zone).padEnd(24)}#${zoneColor(profile, zone).toString(16).padStart(6, "0")}  ${zoneLabel(profile, zone)}`);
}

describe("zone style", () => {
  test("hexagonal and layered share a palette by position", async () => {
    expect(await table(ArchitectureStyle.Hexagonal)).toMatchInlineSnapshot(`
      [
        "inbound-adapter         zone-at-0               #3b82f6  inbound adapters",
        "core                    zone-at-1               #10b981  core",
        "outbound-adapter        zone-at-2               #f59e0b  outbound adapters",
        "edge                    zone-edge               #8a8f98  framework",
        "test-double             zone-test-double        #a1a1aa  test double",
        "external                zone-external           #a855f7  external system",
        "a-zone-of-another-style zone-a-zone-of-another-style#8a8f98  a-zone-of-another-style",
      ]
    `);
    expect(await table(ArchitectureStyle.Layered)).toMatchInlineSnapshot(`
      [
        "presentation            zone-at-0               #3b82f6  presentation",
        "business                zone-at-1               #10b981  business",
        "data                    zone-at-2               #f59e0b  data access",
        "edge                    zone-edge               #8a8f98  framework",
        "test-double             zone-test-double        #a1a1aa  test double",
        "external                zone-external           #a855f7  external system",
        "a-zone-of-another-style zone-a-zone-of-another-style#8a8f98  a-zone-of-another-style",
      ]
    `);
  });
});
