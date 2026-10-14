import { afterEach, beforeEach, expect, test } from "vitest";

import { LoudGreeter } from "../src/greeter";

let greeter: LoudGreeter;

beforeEach(() => {
  greeter = new LoudGreeter("!");
});

afterEach(() => {
  greeter.close();
});

test("greets by name", () => {
  expect(greeter.greet("ada")).toBe("hello ada!");
});
