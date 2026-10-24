import { LayoutShape, SystemGraph } from "@runshape/core";

import { layoutBands } from "./bands-layout";
import type { FloorLayout } from "./floor";
import { layoutHexagon } from "./hexagon-layout";
import { layoutTriangle } from "./triangle-layout";

/** The floor the style is drawn on: the hexagon, terraces for layers, or a triangle of roles. */
export function layoutFloor(graph: SystemGraph): FloorLayout {
  switch (graph.profile.layout) {
    case LayoutShape.Hexagon:
      return layoutHexagon(graph);
    case LayoutShape.Bands:
      return layoutBands(graph);
    case LayoutShape.Triangle:
      return layoutTriangle(graph);
  }
}
