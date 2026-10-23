// The outbound adapters the CLI wires into core's recordings workflow: the recorders (here, and
// in a Docker sandbox), GitHub's pull requests (gh), the project's own working tree, and
// hashing. Each implements a port core declares. (Language models are infra's.)
export * from "./docker-recorder";
export * from "./node-hashing";
export * from "./project-files";
export * from "./pull-requests";
export * from "./shell-recorder";
