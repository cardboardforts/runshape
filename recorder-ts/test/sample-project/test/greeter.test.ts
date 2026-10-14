import { afterEach, beforeEach, expect, test } from "vitest";

import { Greeter } from "../src/greeter";

let greeter: Greeter;

beforeEach(() => {
  greeter = new Greeter();
  greeter.open();
});

afterEach(() => {
  greeter.close();
});

test("greets by name", () => {
  expect(greeter.greet("ada")).toBe("hello ada");
});
