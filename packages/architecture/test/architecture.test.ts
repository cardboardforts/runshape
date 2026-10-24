/**
 * Prototype architecture detection on the two example apps. The point of these snapshots
 * is to show what the evidence looks like, and that two differently shaped apps come out
 * differently — not that the scores are calibrated.
 */
import { describe, expect, test } from "vitest";

import { ArchitectureCandidate, detectArchitecture, proposedRules } from "../src/architecture";
import { ArchitectureStyle, QualifiedName } from "@runshape/kernel";
import { loadFixtureRun } from "../../kernel/test/fixtures";

const describeTop = (candidates: ArchitectureCandidate[]) =>
  candidates.slice(0, 3).map((c) => ({
    style: c.style,
    score: c.score,
    evidence: c.evidence,
    zones: Object.fromEntries(c.zones.filter((z) => z.patterns.length).map((z) => [z.zone, z.patterns])),
  }));

describe("detectArchitecture", () => {
  test("FastAPI RealWorld reads as layered: routes, services, repositories", async () => {
    const candidates = detectArchitecture(await loadFixtureRun("fastapi"));

    expect(candidates[0]?.style).toBe(ArchitectureStyle.Layered);
    expect(describeTop(candidates)).toMatchInlineSnapshot(`
      [
        {
          "evidence": [
            "Presentation: app.api, app.api.dependencies, app.api.routes",
            "Business: app.models.domain, app.services",
            "Data access: app.db, app.db.queries, app.db.repositories, app.models",
            "persistence sits behind repositories/gateways: ArticlesRepository, ProfilesRepository, TagsRepository and 1 more",
            "request handlers call persistence directly (4 call paths): a relaxed layering",
          ],
          "score": 0.96,
          "style": "layered",
          "zones": {
            "business": [
              "app.models.domain.**",
              "app.services.**",
            ],
            "data": [
              "app.db.**",
              "app.db.queries.**",
              "app.db.repositories.**",
              "app.models.**",
            ],
            "presentation": [
              "app.api.**",
              "app.api.dependencies.**",
              "app.api.routes.**",
            ],
          },
        },
        {
          "evidence": [
            "Inbound adapters: app.api, app.api.routes",
            "Core: app.core, app.models.domain, app.services",
            "Outbound adapters: app.db, app.db.repositories",
            "persistence sits behind repositories/gateways: ArticlesRepository, ProfilesRepository, TagsRepository and 1 more",
            "request handlers call persistence directly (4 call paths), bypassing any core",
          ],
          "score": 0.77,
          "style": "hexagonal",
          "zones": {
            "core": [
              "app.core.**",
              "app.models.domain.**",
              "app.services.**",
            ],
            "inbound-adapter": [
              "app.api.**",
              "app.api.routes.**",
            ],
            "outbound-adapter": [
              "app.db.**",
              "app.db.repositories.**",
            ],
          },
        },
        {
          "evidence": [
            "Model: app.models",
          ],
          "score": 0.26,
          "style": "mvc",
          "zones": {
            "model": [
              "app.models.**",
            ],
          },
        },
      ]
    `);
  });

  test("Django RealWorld reads as MVC (MVT): views, active-record models, renderers", async () => {
    const candidates = detectArchitecture(await loadFixtureRun("django"));

    expect(candidates[0]?.style).toBe(ArchitectureStyle.Mvc);
    expect(describeTop(candidates)).toMatchInlineSnapshot(`
      [
        {
          "evidence": [
            "Controller: conduit.apps.articles.views, conduit.apps.authentication.views, conduit.apps.profiles.views",
            "Model: conduit.apps.articles.models, conduit.apps.articles.signals, conduit.apps.authentication.models, conduit.apps.authentication.signals, conduit.apps.profiles.models",
            "View: conduit.apps.articles.serializers, conduit.apps.authentication.renderers, conduit.apps.authentication.serializers, conduit.apps.core.renderers, conduit.apps.profiles.serializers",
            "models query the database themselves (active record): UserManager, Profile",
          ],
          "score": 1,
          "style": "mvc",
          "zones": {
            "controller": [
              "conduit.apps.articles.views.**",
              "conduit.apps.authentication.views.**",
              "conduit.apps.profiles.views.**",
            ],
            "model": [
              "conduit.apps.articles.models.**",
              "conduit.apps.articles.signals.**",
              "conduit.apps.authentication.models.**",
              "conduit.apps.authentication.signals.**",
              "conduit.apps.profiles.models.**",
            ],
            "view": [
              "conduit.apps.articles.serializers.**",
              "conduit.apps.authentication.renderers.**",
              "conduit.apps.authentication.serializers.**",
              "conduit.apps.core.renderers.**",
              "conduit.apps.profiles.serializers.**",
            ],
          },
        },
        {
          "evidence": [
            "Presentation: conduit.apps.articles.serializers, conduit.apps.articles.views, conduit.apps.authentication.serializers, conduit.apps.authentication.views, conduit.apps.profiles.serializers, conduit.apps.profiles.views",
            "Data access: conduit.apps.articles.models, conduit.apps.authentication.models, conduit.apps.profiles.models",
            "request handlers call persistence directly (8 call paths): a relaxed layering",
          ],
          "score": 0.51,
          "style": "layered",
          "zones": {
            "data": [
              "conduit.apps.articles.models.**",
              "conduit.apps.authentication.models.**",
              "conduit.apps.profiles.models.**",
            ],
            "presentation": [
              "conduit.apps.articles.serializers.**",
              "conduit.apps.articles.views.**",
              "conduit.apps.authentication.serializers.**",
              "conduit.apps.authentication.views.**",
              "conduit.apps.profiles.serializers.**",
              "conduit.apps.profiles.views.**",
            ],
          },
        },
        {
          "evidence": [
            "View: conduit.apps.articles.views, conduit.apps.authentication.views, conduit.apps.profiles.views",
            "Model: conduit.apps.articles.models, conduit.apps.authentication.models, conduit.apps.profiles.models",
            "a request/response backend: MVVM and MVP are UI patterns",
          ],
          "score": 0.28,
          "style": "mvvm",
          "zones": {
            "model": [
              "conduit.apps.articles.models.**",
              "conduit.apps.authentication.models.**",
              "conduit.apps.profiles.models.**",
            ],
            "view": [
              "conduit.apps.articles.views.**",
              "conduit.apps.authentication.views.**",
              "conduit.apps.profiles.views.**",
            ],
          },
        },
      ]
    `);
  });
});

describe("proposedRules", () => {
  test("nested packages that match two zones get the inner one first, so first-match-wins keeps it; same-zone nesting is left out", async () => {
    // app.models.domain is business ("domain") inside app.models, which is data ("models").
    const layered = detectArchitecture(await loadFixtureRun("fastapi")).find((c) => c.style === ArchitectureStyle.Layered)!;

    const rules = proposedRules(layered);

    expect(rules.profile.style).toBe("layered");
    expect(rules.rules.map((rule) => `${rule.match.padEnd(26)} ${rule.zone.padEnd(13)} ${rule.by}: ${rule.reason}`)).toMatchInlineSnapshot(`
      [
        "app.models.domain.**       business      detected: business: the package is named "domain"",
        "app.api.**                 presentation  detected: presentation: the package is named "api"",
        "app.db.**                  data          detected: data access: the package is named "db"",
        "app.models.**              data          detected: data access: the package is named "models"",
        "app.services.**            business      detected: business: the package is named "services"",
      ]
    `);
    expect(rules.matchFor(new QualifiedName("app.models.domain.users.UserInDB".split(".")))?.rule.zone).toBe("business");
    expect(rules.matchFor(new QualifiedName("app.models.common.DateTimeModelMixin".split(".")))?.rule.zone).toBe("data");
  });
});
