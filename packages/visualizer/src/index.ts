// The visualizer module: what one recording looks like to the viewer, built from the kernel's
// values. A component's functions and their time (component-view), a function's lines and
// the tests through them (function-view), objects and their wiring (object-graph), a test as a
// timeline, and the visual model: each zoom level reduced to what's drawn, placed for 2D and 3D
// (layout). Imports only the kernel.
export * from "./component-view";
export * from "./function-view";
export * from "./object-graph";
export * from "./timeline";
export * from "./layout";
