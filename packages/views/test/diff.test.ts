/**
 * Behavioural diff on a real change. The fixture is two recordings of the Django example:
 * before and after fixing its routing bug (articles/feed was registered after the router's
 * articles/<slug> route, so the feed request was answered by the article-detail view with a
 * 404). The fix moves one URL pattern. The diff should say exactly that, and nothing else.
 */
import { describe, expect, test } from "vitest";

import {  } from "@runshape/trace";
import { Change, diffRuns } from "../src";
import { fixtureRuns } from "../../trace/test/fixtures";

async function loadFeedFix() {
  const runs = fixtureRuns("django-feed-fix");
  const before = await runs.previous();
  const after = await runs.latest();
  if (before === null) throw new Error("fixture has no previous run");
  return { before, after };
}

describe("diffRuns", () => {
  test("the routing fix changes one journey: the feed request now reaches the feed view", async () => {
    const { before, after } = await loadFeedFix();

    const diff = diffRuns(before, after, { grouping: { collapseMiddleware: true } });

    const changed = diff.scenarios.filter((scenario) => scenario.change !== Change.Unchanged);
    expect(changed).toMatchInlineSnapshot(`
      [
        {
          "change": "changed",
          "functionsChanged": [
            {
              "linesNoLongerReached": [],
              "linesNowReached": [
                218,
                219,
              ],
              "symbol": {
                "key": "[["conduit","apps","articles","views"],["ArticlesFeedAPIView"],"get_queryset"]",
                "kind": "method",
                "namespace": "conduit.apps.articles.views",
                "path": "ArticlesFeedAPIView.get_queryset",
              },
            },
            {
              "linesNoLongerReached": [],
              "linesNowReached": [
                223,
                224,
                226,
                227,
                228,
                231,
              ],
              "symbol": {
                "key": "[["conduit","apps","articles","views"],["ArticlesFeedAPIView"],"list"]",
                "kind": "method",
                "namespace": "conduit.apps.articles.views",
                "path": "ArticlesFeedAPIView.list",
              },
            },
            {
              "linesNoLongerReached": [
                72,
                74,
                75,
                76,
                77,
              ],
              "linesNowReached": [],
              "symbol": {
                "key": "[["conduit","apps","articles","views"],["ArticleViewSet"],"retrieve"]",
                "kind": "method",
                "namespace": "conduit.apps.articles.views",
                "path": "ArticleViewSet.retrieve",
              },
            },
            {
              "linesNoLongerReached": [
                36,
                38,
                39,
                41,
                42,
                43,
                50,
              ],
              "linesNowReached": [],
              "symbol": {
                "key": "[["conduit","apps","core","exceptions"],[],"_handle_not_found_error"]",
                "kind": "function",
                "namespace": "conduit.apps.core.exceptions",
                "path": "_handle_not_found_error",
              },
            },
            {
              "linesNoLongerReached": [
                8,
                9,
                10,
                11,
                16,
                18,
                22,
              ],
              "linesNowReached": [],
              "symbol": {
                "key": "[["conduit","apps","core","exceptions"],[],"core_exception_handler"]",
                "kind": "function",
                "namespace": "conduit.apps.core.exceptions",
                "path": "core_exception_handler",
              },
            },
            {
              "linesNoLongerReached": [
                24,
              ],
              "linesNowReached": [
                14,
                15,
                16,
              ],
              "symbol": {
                "key": "[["conduit","apps","core","renderers"],["ConduitJSONRenderer"],"render"]",
                "kind": "method",
                "namespace": "conduit.apps.core.renderers",
                "path": "ConduitJSONRenderer.render",
              },
            },
          ],
          "hopsAdded": [
            "ArticlesFeedAPIView -> ArticleSerializer",
            "ArticlesFeedAPIView -> ProfileSerializer",
            "ArticlesFeedAPIView -> TagRelatedField",
            "ArticlesFeedAPIView -> sqlite",
            "Middleware -> ArticlesFeedAPIView",
          ],
          "hopsRemoved": [
            "Middleware -> core.exceptions",
          ],
          "id": "tests/test_user_journeys.py::test_follower_sees_followed_authors_in_their_feed",
          "name": "test_follower_sees_followed_authors_in_their_feed",
          "outcomeAfter": "passed",
          "outcomeBefore": "xfailed",
          "statementsAdded": [
            "sqlite: SELECT "articles_article"."id", "articles_article"."created_at", "articles_article"."updated_at", "articles_article"."slug", "articles_article"."title", "articles_article"."description", "articles_article"."body", "articles_article"."author_id" FROM "articles_article" WHERE "articles_article"."author_id" IN (SELECT U0."id" FROM "profiles_profile" U0 INNER JOIN "profiles_profile_follows" U1 ON (U0."id" = U1."to_profile_id") WHERE U1."from_profile_id" = %s) ORDER BY "articles_article"."created_at"",
            "sqlite: SELECT "articles_tag"."id", "articles_tag"."created_at", "articles_tag"."updated_at", "articles_tag"."tag", "articles_tag"."slug" FROM "articles_tag" INNER JOIN "articles_article_tags" ON ("articles_tag"."id" = "articles_article_tags"."tag_id") WHERE "articles_article_tags"."article_id" = %s ORDER BY "articles_tag"."created_at" DESC, "articles_tag"."updated_at" DESC",
            "sqlite: SELECT "authentication_user"."id", "authentication_user"."password", "authentication_user"."last_login", "authentication_user"."is_superuser", "authentication_user"."created_at", "authentication_user"."updated_at", "authentication_user"."username", "authentication_user"."email", "authentication_user"."is_active", "authentication_user"."is_staff" FROM "authentication_user" WHERE "authentication_user"."id" = %s LIMIT 21",
            "sqlite: SELECT "profiles_profile"."id", "profiles_profile"."created_at", "profiles_profile"."updated_at", "profiles_profile"."user_id", "profiles_profile"."bio", "profiles_profile"."image" FROM "profiles_profile" WHERE "profiles_profile"."id" = %s LIMIT 21",
            "sqlite: SELECT "profiles_profile"."id", "profiles_profile"."created_at", "profiles_profile"."updated_at", "profiles_profile"."user_id", "profiles_profile"."bio", "profiles_profile"."image" FROM "profiles_profile" WHERE "profiles_profile"."user_id" = %s LIMIT 21",
            "sqlite: SELECT %s AS "a" FROM "articles_article" INNER JOIN "profiles_profile_favorites" ON ("articles_article"."id" = "profiles_profile_favorites"."article_id") WHERE ("profiles_profile_favorites"."profile_id" = %s AND "articles_article"."id" = %s) LIMIT 1",
            "sqlite: SELECT %s AS "a" FROM "profiles_profile" INNER JOIN "profiles_profile_follows" ON ("profiles_profile"."id" = "profiles_profile_follows"."to_profile_id") WHERE ("profiles_profile_follows"."from_profile_id" = %s AND "profiles_profile"."id" = %s) LIMIT 1",
            "sqlite: SELECT COUNT(*) AS "__count" FROM "articles_article" WHERE "articles_article"."author_id" IN (SELECT U0."id" FROM "profiles_profile" U0 INNER JOIN "profiles_profile_follows" U1 ON (U0."id" = U1."to_profile_id") WHERE U1."from_profile_id" = %s)",
            "sqlite: SELECT COUNT(*) AS "__count" FROM "profiles_profile_favorites" WHERE "profiles_profile_favorites"."article_id" = %s",
          ],
          "statementsRemoved": [
            "sqlite: SELECT "articles_article"."id", "articles_article"."created_at", "articles_article"."updated_at", "articles_article"."slug", "articles_article"."title", "articles_article"."description", "articles_article"."body", "articles_article"."author_id", "profiles_profile"."id", "profiles_profile"."created_at", "profiles_profile"."updated_at", "profiles_profile"."user_id", "profiles_profile"."bio", "profiles_profile"."image", "authentication_user"."id", "authentication_user"."password", "authentication_u",
          ],
        },
      ]
    `);
  });

  test("on the graph, the feed view is new and the components it uses carry more traffic", async () => {
    const { before, after } = await loadFeedFix();

    const diff = diffRuns(before, after, { grouping: { collapseMiddleware: true } });

    expect(diff.nodes.filter((n) => n.change !== Change.Unchanged).map((n) => `${n.change} ${n.label}`)).toMatchInlineSnapshot(`
      [
        "changed TagRelatedField",
        "changed ArticleSerializer",
        "added ArticlesFeedAPIView",
        "changed ArticleViewSet",
        "changed Profile",
        "changed ProfileSerializer",
        "changed sqlite",
        "changed URLResolver",
        "changed core.exceptions",
      ]
    `);
    expect(diff.edges.filter((e) => e.change === Change.Added || e.change === Change.Removed).map((e) => `${e.change} ${e.id}`))
      .toMatchInlineSnapshot(`
        [
          "added class:conduit.apps.articles.views.ArticlesFeedAPIView->class:conduit.apps.articles.relations.TagRelatedField",
          "added class:conduit.apps.articles.views.ArticlesFeedAPIView->class:conduit.apps.articles.serializers.ArticleSerializer",
          "added class:conduit.apps.articles.views.ArticlesFeedAPIView->class:conduit.apps.profiles.serializers.ProfileSerializer",
          "added class:conduit.apps.articles.views.ArticlesFeedAPIView->external:sqlite",
          "added landmark:middleware-chain->class:conduit.apps.articles.views.ArticlesFeedAPIView",
        ]
      `);
  });

  test("recordings that differ for reasons other than the code say so", async () => {
    const { before, after } = await loadFeedFix();
    const withVersion = (run: typeof before, version: string) =>
      Object.assign(Object.create(Object.getPrototypeOf(run)), run, { recorderVersion: version });

    expect(diffRuns(before, after).caveats).toEqual([]);
    expect(diffRuns(withVersion(before, "0.1.0"), withVersion(after, "0.2.0")).caveats).toMatchInlineSnapshot(`
      [
        "Recorded by different recorder versions (0.1.0 → 0.2.0); some differences may come from the recorder, not the code.",
      ]
    `);
  });

  test("with only one recording there is nothing to compare against", async () => {
    expect(await fixtureRuns("django").previous()).toBeNull();
  });
});
