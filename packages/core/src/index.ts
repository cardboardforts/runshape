// The kernel (renamed so in Phase 0b): the shared words and ports, the UI protocol, and, until
// Phase 0b moves them to their modules, the architecture advice and folder guides. It still
// re-exports the packages below for the webview (PLAN.md: the UI's types wait for Phase 3).
export * from "@runshape/trace";
export * from "@runshape/architecture";
export * from "@runshape/views";
export * from "./architecture";
export * from "./architecture-advice";
export * from "./json-answer";
export * from "./folder-description";
export * from "./folder-readme";
export * from "./language-model";
export * from "./recordings-model";
export * from "./recordings-ports";
export * from "./ui-protocol";
export * from "./zone-advice";
