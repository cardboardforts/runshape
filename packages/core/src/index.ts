// The viewer's application layer: the session that answers the webview's requests (session.ts,
// ui-protocol.ts), and the advice on which architecture an app follows (architecture.ts, by
// heuristic; architecture-advice.ts and zone-advice.ts, by asking a model). It re-exports the
// packages below so the adapters (webview, extension, CLI) depend on @runshape/core alone.
export * from "@runshape/trace";
export * from "@runshape/architecture";
export * from "@runshape/views";
export * from "./architecture";
export * from "./architecture-advice";
export * from "./explainer";
export * from "./folder-description";
export * from "./folder-readme";
export * from "./language-model";
export * from "./recordings-model";
export * from "./recordings-ports";
export * from "./review-bundle";
export * from "./session";
export * from "./ui-protocol";
export * from "./zone-advice";
