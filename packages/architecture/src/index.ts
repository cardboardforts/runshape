// The arch module: the architecture styles and their zones (profiles.ts), the zone rules a
// project declares in runshape.json (zones.ts), the system graph drawn with them
// (system-graph.ts), where each class sits and how that moved (placements, architecture-diff),
// folder guides, and the language-model skills that propose styles and zones. Imports only the
// kernel.
export * from "./profiles";
export * from "./system-graph";
export * from "./zones";
export * from "./seams";
export * from "./architecture";
export * from "./architecture-advice";
export * from "./architecture-diff";
export * from "./folder-description";
export * from "./folder-guide";
export * from "./folder-readme";
export * from "./placements";
export * from "./zone-advice";
