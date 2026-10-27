// Where files are kept and how they're read: storage only, never a format. Imports no other
// Runshape package; the domain's ports (trace's TraceFiles, …) are declared where they're
// needed, and the stores here fit them by shape.
export * from "./paths";
export * from "./node-files";
export * from "./folders";
export * from "./hashing";
export * from "./logfmt";
