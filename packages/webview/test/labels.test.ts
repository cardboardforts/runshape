import { describe, expect, test } from "vitest";

import { chooseVisibleLabels, LabelBox, LabelTier, labelPriority } from "../src/three/labels";

const VIEWPORT = { width: 800, height: 600 };
const box = (id: string, x: number, y: number, tier = LabelTier.Normal, calls = 1): LabelBox => ({
  id,
  x,
  y,
  width: 100,
  height: 18,
  priority: labelPriority(tier, calls),
});

describe("chooseVisibleLabels", () => {
  test("of two overlapping labels the busier component keeps its name; separate labels both show", () => {
    const visible = chooseVisibleLabels(
      [box("UsersRepository", 400, 300, LabelTier.Normal, 94), box("FakePoolAcquireContent", 440, 305, LabelTier.Normal, 12), box("postgres", 700, 100)],
      VIEWPORT,
    );

    expect([...visible].sort()).toEqual(["UsersRepository", "postgres"]);
  });

  test("what the person is looking at wins over traffic: the replay's hop, then the selected test", () => {
    const busy = box("ArticlesRepository", 400, 300, LabelTier.Dimmed, 382);
    const selected = box("services.articles", 410, 300, LabelTier.Highlighted, 4);
    const active = box("dependencies.database", 420, 300, LabelTier.Active, 15);

    expect([...chooseVisibleLabels([busy, selected], VIEWPORT)]).toEqual(["services.articles"]);
    expect([...chooseVisibleLabels([busy, selected, active], VIEWPORT)]).toEqual(["dependencies.database"]);
  });

  test("labels off screen are never placed, so they can't push visible ones out", () => {
    const visible = chooseVisibleLabels([box("behind", -300, 300, LabelTier.Active), box("Client (tests)", 60, 300)], VIEWPORT);

    expect([...visible]).toEqual(["Client (tests)"]);
  });
});
