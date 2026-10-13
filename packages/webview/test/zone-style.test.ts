/**
 * A style's own zones are coloured by position, not by name: whatever faces the requests is
 * blue, the middle green, the side facing out amber. That keeps the hexagon's original
 * colours and lets a new style render without a palette of its own. Fixed zones (framework,
 * test doubles, externals) look the same in every style.
 */
import { describe, expect, test } from "vitest";

import { ArchitectureStyle, FixedZone, profileFor } from "@runshape/core";

import { zoneClass, zoneColor, zoneLabel } from "../src/zone-style";

function table(style: ArchitectureStyle): string[] {
  const profile = profileFor(style)!;
  const zones = [...profile.zones.map((zone) => zone.id), ...Object.values(FixedZone), "a-zone-of-another-style"];
  return zones.map((zone) => `${zone.padEnd(24)}${zoneClass(profile, zone).padEnd(24)}#${zoneColor(profile, zone).toString(16).padStart(6, "0")}  ${zoneLabel(profile, zone)}`);
}

describe("zone style", () => {
  test("hexagonal and layered share a palette by position", () => {
    expect(table(ArchitectureStyle.Hexagonal)).toMatchInlineSnapshot(`
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
    expect(table(ArchitectureStyle.Layered)).toMatchInlineSnapshot(`
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
