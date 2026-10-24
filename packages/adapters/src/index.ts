// The adapters, by the external system each one talks to: git (git/), GitHub through gh
// (github/), the recorders (recorders/: here, and in a Docker sandbox), language models
// (models/: claude -p, the Anthropic API), the recordings and reviews a project keeps under
// .runshape (library/), and the project's own working tree (project/). Each implements a port
// the kernel declares, and is wired in by an app.
export * from "./git/git-cli";
export * from "./git/git-repository";
export * from "./github/pull-requests";
export * from "./library/library";
export * from "./library/recording-store";
export * from "./library/review-store";
export * from "./models/language-models";
export * from "./project/project-files";
export * from "./recorders/docker-recorder";
export * from "./recorders/shell-recorder";
