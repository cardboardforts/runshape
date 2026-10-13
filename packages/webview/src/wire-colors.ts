// Distinguishable on both light and dark editor themes; cycles after twelve tests.
const WIRE_PALETTE = [
  "#4e9af1",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#8cd17d",
  "#d37295",
  "#a0cbe8",
];

export function wireColor(index: number): string {
  return WIRE_PALETTE[index % WIRE_PALETTE.length] ?? "#888888";
}
