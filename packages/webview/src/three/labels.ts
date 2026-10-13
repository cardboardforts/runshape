/**
 * Which 3D labels to show: on screen, without overlapping, most important first. A culled
 * label's tile is still there and still clickable; only its name is hidden until the camera
 * moves somewhere it fits.
 */
export interface LabelBox {
  id: string;
  /** Screen position of the label's centre, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
}

export enum LabelTier {
  Dimmed = 0,
  Normal = 1,
  Highlighted = 2,
  /** Part of the replay's current hop. */
  Active = 3,
}

/** Tier first; within a tier, busier components keep their names. */
export function labelPriority(tier: LabelTier, calls: number): number {
  return tier * 1_000_000 + Math.min(calls, 999_999);
}

const PADDING = 3;

export function chooseVisibleLabels(boxes: LabelBox[], viewport: { width: number; height: number }): Set<string> {
  const ordered = [...boxes].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const placed: LabelBox[] = [];
  const visible = new Set<string>();
  for (const box of ordered) {
    if (!onScreen(box, viewport)) continue;
    if (placed.some((other) => overlaps(box, other))) continue;
    placed.push(box);
    visible.add(box.id);
  }
  return visible;
}

function onScreen(box: LabelBox, viewport: { width: number; height: number }): boolean {
  return box.x + box.width / 2 > 0 && box.x - box.width / 2 < viewport.width && box.y + box.height / 2 > 0 && box.y - box.height / 2 < viewport.height;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return Math.abs(a.x - b.x) * 2 < a.width + b.width + PADDING * 2 && Math.abs(a.y - b.y) * 2 < a.height + b.height + PADDING * 2;
}
