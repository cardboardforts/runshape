// The kernel (renamed so in Phase 0b): the recordings' words and ports, and the UI protocol;
// with trace's model and format, which fold in here in Phase 0b, step 4. The UI protocol's
// types still name the modules' view models (type-only) until Phase 3's Layout replaces them.
export * from "@runshape/trace";
export * from "./recordings-model";
export * from "./recordings-ports";
export * from "./ui-protocol";
