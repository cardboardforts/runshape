// The adapters, by the external system each one talks to: git (git/), GitHub through gh
// (github/: pull requests, issues, and posting a review), the recorders (recorders/: one per
// language, here and in a Docker sandbox), language models (models/: claude -p, the Anthropic
// API), what a project keeps under .runshape (library/: recordings, reviews, and revision
// requests for a local agent), and the project's own working tree (project/). Each implements
// a port the kernel declares, and is wired in by an app.
export * from "./git/git-cli";
export * from "./git/git-repository";
export * from "./github/issues";
export * from "./github/pull-requests";
export * from "./github/review-comments";
export * from "./library/arrangement-file";
export * from "./library/library";
export * from "./library/recording-store";
export * from "./library/review-store";
export * from "./library/revision-requests";
export * from "./models/language-models";
export * from "./project/project-files";
export * from "./recorders/docker-recorder";
export * from "./recorders/go/go-recorder";
export * from "./recorders/python/python-recorder";
export * from "./recorders/recorders";
export * from "./recorders/typescript/typescript-recorder";
export * from "./recorders/typescript/typescript-sandbox";
export * from "./recorders/python/python-sandbox";
export * from "./recorders/go/go-sandbox";
