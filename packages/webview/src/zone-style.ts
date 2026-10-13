import { ArchitectureProfile, FixedZone, zonePosition } from "@runshape/core";

// A style's own zones are coloured by where they sit in its drawing order — the side facing
// the requests, the middle, the side facing the outside world — so the hexagon keeps its
// blue/green/amber and every other style reads the same way round.
const POSITION_COLOR = [0x3b82f6, 0x10b981, 0xf59e0b];
const UNKNOWN_ZONE_COLOR = 0x8a8f98;

const FIXED: Record<FixedZone, { label: string; color: number }> = {
  [FixedZone.Edge]: { label: "framework", color: 0x8a8f98 },
  [FixedZone.TestDouble]: { label: "test double", color: 0xa1a1aa },
  [FixedZone.External]: { label: "external system", color: 0xa855f7 },
};

function fixed(zone: string): { label: string; color: number } | undefined {
  return FIXED[zone as FixedZone];
}

export function zoneLabel(profile: ArchitectureProfile, zone: string): string {
  const own = profile.zones.find((candidate) => candidate.id === zone);
  return own ? own.name.toLowerCase() : (fixed(zone)?.label ?? zone);
}

export function zoneColor(profile: ArchitectureProfile, zone: string): number {
  const position = zonePosition(profile, zone);
  if (position !== null) return POSITION_COLOR[position] ?? UNKNOWN_ZONE_COLOR;
  return fixed(zone)?.color ?? UNKNOWN_ZONE_COLOR;
}

/** CSS class: fixed zones by id, the style's zones by position (styles.css has both). */
export function zoneClass(profile: ArchitectureProfile, zone: string): string {
  const position = zonePosition(profile, zone);
  return position !== null ? `zone-at-${position}` : `zone-${zone}`;
}
