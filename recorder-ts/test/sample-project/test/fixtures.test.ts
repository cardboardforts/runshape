import { expect, test as base } from "vitest";

import { Greeter } from "../src/greeter";

// vitest fixtures: the setup file must not stop them working while recording.
const test = base.extend<{ greeter: Greeter }>({
  greeter: async ({}, use) => {
    const greeter = new Greeter();
    greeter.open();
    await use(greeter);
  },
});

test("greets with a fixture", ({ greeter }) => {
  expect(greeter.greet("bo")).toBe("hello bo");
});
