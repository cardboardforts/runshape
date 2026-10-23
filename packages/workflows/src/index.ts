// What the apps run: the recordings workflow (Recordings: record, compare, explain, review the
// pull requests asking for review, folder guides), the review bundle it saves, and the viewer
// session that answers the webview. Workflows call modules in order and pass their values on;
// they import modules and the kernel, never infra or a host (GOALS.md).
export * from "./recordings";
export * from "./review-bundle";
export * from "./session";
