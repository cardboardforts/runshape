/**
 * Requests grouped by route, and a route's requests by the path they took through the code
 * (docs/ideas.md, ideas 1 and 4). Real traffic sends hundreds of requests to one route; what a
 * reader needs is the handful of different things the code did with them: placed, refused by
 * the rules, malformed. Each of those is a variant, described by how it differs from the
 * route's main path, so "refused" reads as "skips MemoryRepository.Save".
 *
 * The rendering below is the test's own, so the snapshots read as what the view shows.
 */
import { describe, expect, test } from "vitest";

import { loadLatestRun, loadPreviousRun, Phase, Run } from "@runshape/trace";
import { buildRouteMap, Change, Op, detectMoves, diffRouteMaps, RouteMap, RouteMapDiff, RouteVariant } from "../src";
import { FixtureApp, fixtureFiles, loadFixtureRun } from "../../trace/test/fixtures";

function render(map: RouteMap): string {
  const lines: string[] = [];
  for (const route of map.routes) {
    lines.push(`${route.label}${route.routed ? "" : " (no route matched)"}: ${route.requestCount} request(s)`);
    for (const variant of route.variants) {
      lines.push(`  ×${variant.requests.length} ${how(variant)} [${variant.requests.map((request) => request.scenarioName).join(", ")}]`);
      for (const step of variant.steps) lines.push(`      ${"  ".repeat(step.depth)}${step.label}${step.repeated ? " (repeats)" : ""}`);
    }
  }
  if (map.scenariosWithoutRequests > 0) lines.push(`${map.scenariosWithoutRequests} scenario(s) sent no request`);
  return lines.join("\n");
}

function how(variant: RouteVariant): string {
  if (!variant.reachedHandler) return `never reached the handler; ran ${variant.adds.join(", ") || "no project code"}`;
  if (variant.isMain) return "main path";
  const parts = [variant.skips.length ? `skips ${variant.skips.join(", ")}` : "", variant.adds.length ? `adds ${variant.adds.join(", ")}` : ""];
  return parts.filter(Boolean).join("; ") || "same calls, nested or ordered differently";
}

/** Unchanged routes are one line: the change is what a reviewer reads. */
function renderDiff(diff: RouteMapDiff): string {
  const lines: string[] = [];
  for (const route of diff.routes) {
    if (route.change === Change.Unchanged) {
      lines.push(`${route.label}: unchanged (${route.variants.length} variant(s))`);
      continue;
    }
    lines.push(`${route.label}: ${route.change}`);
    for (const { change, variant, before, after, nowCalls, noLongerCalls } of route.variants) {
      const delta = change === Change.Changed ? `now calls ${nowCalls.join(", ") || "nothing new"}; no longer calls ${noLongerCalls.join(", ") || "nothing"}` : how(variant);
      lines.push(`  ${change} ${before}→${after}: ${delta} [${variant.requests.map((request) => request.scenarioName).join(", ")}]`);
    }
  }
  return lines.join("\n");
}

describe("buildRouteMap", () => {
  test("a running Go shop: two routes, and POST /orders taken three ways", async () => {
    const run = await loadFixtureRun("go-shop-running");

    // Paths carry ids (/orders/ord-1): requests group by the route that served them, read
    // from the handler they reached, not by their path text.
    expect(render(buildRouteMap(run))).toMatchInlineSnapshot(`
      "GET /orders/{id}: 3 request(s)
        ×2 main path [GET /orders/warmup #1, GET /orders/ord-42 #6]
            Handler.getOrder
              Service.Get
                MemoryRepository.Find
              writeJSON
                statusRecorder.WriteHeader
        ×1 adds Order.TotalCents [GET /orders/ord-1 #3]
            Handler.getOrder
              Service.Get
                MemoryRepository.Find
              Order.TotalCents
              writeJSON
                statusRecorder.WriteHeader
      POST /orders: 3 request(s)
        ×1 main path [POST /orders #2]
            Handler.placeOrder
              Service.Place
                Order.Problems
                MemoryRepository.Save
              writeJSON
                statusRecorder.WriteHeader
        ×1 skips MemoryRepository.Save [POST /orders #4]
            Handler.placeOrder
              Service.Place
                Order.Problems
              writeJSON
                statusRecorder.WriteHeader
        ×1 skips Service.Place, Order.Problems, MemoryRepository.Save [POST /orders #5]
            Handler.placeOrder
              writeJSON
                statusRecorder.WriteHeader
      1 scenario(s) sent no request"
    `);
  });

  test("Python apps: routes come from the framework's table, class-based views by method and shape", async () => {
    // FastAPI's handlers are functions; Django REST's are classes whose method ran, and one
    // class serves several patterns (the list and the detail), told apart by the path.
    const routes = async (app: FixtureApp) => render(buildRouteMap(await loadFixtureRun(app)));

    expect(await routes("fastapi")).toMatchInlineSnapshot(`
      "POST /api/articles: 2 request(s)
        ×1 main path [test_user_can_create_article]
            create_new_article
              get_slug_for_article
              check_article_exists
                ArticlesRepository.get_article_by_slug
                  BaseRepository.connection
                  postgres asyncpg.connection.Connection.fetchrow
              ArticlesRepository.create_article
                BaseRepository.connection
                postgres asyncpg.connection.Connection.execute
                BaseRepository.connection
                postgres asyncpg.connection.Connection.fetchrow
                postgres asyncpg.connection.Connection.execute
                ArticlesRepository._get_article_from_db_record
                  ProfilesRepository.get_profile_by_username
                    UsersRepository.get_user_by_username
                      BaseRepository.connection
                      postgres asyncpg.connection.Connection.fetchrow
                      DateTimeModelMixin.default_datetime (repeats)
                    ProfilesRepository.is_user_following_for_another_user
                      BaseRepository.connection
                      postgres asyncpg.connection.Connection.fetchrow
                  ArticlesRepository.get_tags_for_article_by_slug
                    BaseRepository.connection
                    postgres asyncpg.connection.Connection.fetch
                    ArticlesRepository.get_tags_for_article_by_slug.<locals>.<listcomp>
                  ArticlesRepository.get_favorites_count_for_article_by_slug
                    BaseRepository.connection
                    postgres asyncpg.connection.Connection.fetchrow
                  ArticlesRepository.is_article_favorited_by_user
                    BaseRepository.connection
                    postgres asyncpg.connection.Connection.fetchrow
                  DateTimeModelMixin.default_datetime (repeats)
              DateTimeModelMixin.default_datetime (repeats)
        ×1 skips ArticlesRepository.create_article, postgres asyncpg.connection.Connection.execute, ProfilesRepository.is_user_following_for_another_user, ArticlesRepository.is_article_favorited_by_user [test_user_can_not_create_article_with_duplicated_slug]
            create_new_article
              get_slug_for_article
              check_article_exists
                ArticlesRepository.get_article_by_slug
                  BaseRepository.connection
                  postgres asyncpg.connection.Connection.fetchrow
                  ArticlesRepository._get_article_from_db_record
                    ProfilesRepository.get_profile_by_username
                      UsersRepository.get_user_by_username
                        BaseRepository.connection
                        postgres asyncpg.connection.Connection.fetchrow
                        DateTimeModelMixin.default_datetime (repeats)
                    ArticlesRepository.get_tags_for_article_by_slug
                      BaseRepository.connection
                      postgres asyncpg.connection.Connection.fetch
                      ArticlesRepository.get_tags_for_article_by_slug.<locals>.<listcomp>
                    ArticlesRepository.get_favorites_count_for_article_by_slug
                      BaseRepository.connection
                      postgres asyncpg.connection.Connection.fetchrow
                    DateTimeModelMixin.default_datetime (repeats)
      GET /api/articles/feed: 1 request(s)
        ×1 main path [test_empty_feed_if_user_has_not_followings]
            get_articles_for_user_feed
              ArticlesRepository.get_articles_for_user_feed
                BaseRepository.connection
                postgres asyncpg.connection.Connection.fetch
                ArticlesRepository.get_articles_for_user_feed.<locals>.<listcomp>
              get_articles_for_user_feed.<locals>.<listcomp>
      POST /api/users: 1 request(s)
        ×1 main path [test_user_success_registration]
            register
              check_username_is_taken
                UsersRepository.get_user_by_username
                  BaseRepository.connection
                  postgres asyncpg.connection.Connection.fetchrow
              check_email_is_taken
                UsersRepository.get_user_by_email
                  BaseRepository.connection
                  postgres asyncpg.connection.Connection.fetchrow
              UsersRepository.create_user
                UserInDB.change_password
                  generate_salt
                  get_password_hash
                BaseRepository.connection
                postgres asyncpg.connection.Connection.execute
                BaseRepository.connection
                postgres asyncpg.connection.Connection.fetchrow
                postgres asyncpg.connection.Connection.execute
              create_access_token_for_user
                create_jwt_token"
    `);
    expect(await routes("django")).toMatchInlineSnapshot(`
      "POST /api/users: 10 request(s)
        ×10 main path [test_visitor_registers_an_account, test_member_logs_in_and_reads_their_profile, test_author_publishes_a_tagged_article, test_reader_browses_articles_by_tag, test_reader_favorites_and_comments_on_an_article, test_reader_favorites_and_comments_on_an_article, test_reader_follows_an_author, test_reader_follows_an_author, test_follower_sees_followed_authors_in_their_feed, test_follower_sees_followed_authors_in_their_feed]
            RegistrationAPIView.post
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              RegistrationSerializer.create
                UserManager.create_user
                  sqlite django.db.backends.utils.CursorWrapper.execute
                  create_related_profile
                    sqlite django.db.backends.utils.CursorWrapper.execute
              User.token
                User._generate_jwt_token
      POST /api/users/login: 1 request(s)
        ×1 main path [test_member_logs_in_and_reads_their_profile]
            LoginAPIView.post
              LoginSerializer.validate
                sqlite django.db.backends.utils.CursorWrapper.execute
                User.token
                  User._generate_jwt_token
      GET /api/user: 1 request(s)
        ×1 main path [test_member_logs_in_and_reads_their_profile]
            UserRetrieveUpdateAPIView.retrieve
              User.token
                User._generate_jwt_token
              sqlite django.db.backends.utils.CursorWrapper.execute
      POST /api/articles: 6 request(s)
        ×5 main path [test_author_publishes_a_tagged_article, test_reader_browses_articles_by_tag, test_reader_browses_articles_by_tag, test_reader_favorites_and_comments_on_an_article, test_follower_sees_followed_authors_in_their_feed]
            ArticleViewSet.create
              sqlite django.db.backends.utils.CursorWrapper.execute
              TagRelatedField.to_internal_value (repeats)
                sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              ArticleSerializer.create
                add_slug_to_article_if_not_exists
                  generate_random_string
                    generate_random_string.<locals>.<genexpr>
                sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              ProfileSerializer.get_image
              ProfileSerializer.get_following
                Profile.is_following
                  sqlite django.db.backends.utils.CursorWrapper.execute
              ArticleSerializer.get_created_at
              ArticleSerializer.get_favorited
                Profile.has_favorited
                  sqlite django.db.backends.utils.CursorWrapper.execute
              ArticleSerializer.get_favorites_count
                sqlite django.db.backends.utils.CursorWrapper.execute
              sqlite django.db.backends.utils.CursorWrapper.execute
              TagRelatedField.to_representation (repeats)
              ArticleSerializer.get_updated_at
        ×1 never reached the handler; ran JWTAuthentication.authenticate, core_exception_handler, ConduitJSONRenderer.render [test_anonymous_visitor_cannot_publish]
            JWTAuthentication.authenticate
            core_exception_handler
            ConduitJSONRenderer.render
      GET /api/articles: 1 request(s)
        ×1 main path [test_reader_browses_articles_by_tag]
            ArticleViewSet.list
              ArticleViewSet.get_queryset
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              ProfileSerializer.get_image
              ProfileSerializer.get_following
              ArticleSerializer.get_created_at
              ArticleSerializer.get_favorited
              ArticleSerializer.get_favorites_count
                sqlite django.db.backends.utils.CursorWrapper.execute
              sqlite django.db.backends.utils.CursorWrapper.execute
              TagRelatedField.to_representation
              ArticleSerializer.get_updated_at
      POST /api/articles/{article_slug}/favorite: 1 request(s)
        ×1 main path [test_reader_favorites_and_comments_on_an_article]
            ArticlesFavoriteAPIView.post
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              Profile.favorite
                sqlite django.db.backends.utils.CursorWrapper.execute
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              ProfileSerializer.get_image
              ProfileSerializer.get_following
                Profile.is_following
                  sqlite django.db.backends.utils.CursorWrapper.execute
              ArticleSerializer.get_created_at
              ArticleSerializer.get_favorited
                Profile.has_favorited
                  sqlite django.db.backends.utils.CursorWrapper.execute
              ArticleSerializer.get_favorites_count
                sqlite django.db.backends.utils.CursorWrapper.execute
              sqlite django.db.backends.utils.CursorWrapper.execute
              TagRelatedField.to_representation
              ArticleSerializer.get_updated_at
      POST /api/articles/{article_slug}/comments: 1 request(s)
        ×1 main path [test_reader_favorites_and_comments_on_an_article]
            CommentsListCreateAPIView.create
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              CommentSerializer.create
                sqlite django.db.backends.utils.CursorWrapper.execute
              ProfileSerializer.get_image
              ProfileSerializer.get_following
              CommentSerializer.get_created_at
              CommentSerializer.get_updated_at
      POST /api/profiles/{username}/follow: 2 request(s)
        ×2 main path [test_reader_follows_an_author, test_follower_sees_followed_authors_in_their_feed]
            ProfileFollowAPIView.post
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              Profile.follow
                sqlite django.db.backends.utils.CursorWrapper.execute
              sqlite django.db.backends.utils.CursorWrapper.execute
              ProfileSerializer.get_image
              ProfileSerializer.get_following
                Profile.is_following
                  sqlite django.db.backends.utils.CursorWrapper.execute
      GET /api/articles/{slug}: 1 request(s)
        ×1 main path [test_follower_sees_followed_authors_in_their_feed]
            ArticleViewSet.retrieve
              sqlite django.db.backends.utils.CursorWrapper.execute"
    `);
  });

  test("a variant is the same whichever of its requests came first: a step repeats if it looped in any of them", async () => {
    const run = await loadFixtureRun("django");
    const reversed = new Run(run.root, run.createdAt, run.language, run.runtime, run.backend, run.topology, run.catalog, [...run.scenarios].reverse(), run.problems);
    const articles = (map: RouteMap) => map.routes.find((route) => route.label === "POST /api/articles")!.variants.find((variant) => variant.isMain)!.steps;

    // Publishing an article looks its tags up one by one: a loop in some requests, not in
    // others. Read in reverse order, the step still shows as repeating.
    expect(articles(buildRouteMap(reversed))).toEqual(articles(buildRouteMap(run)));
  });

  test("when most requests are turned away, the main path is still the one that reached the handler", async () => {
    const run = await loadFixtureRun("django");
    const named = (name: string) => run.scenarios.find((scenario) => scenario.name === name)!;
    const refused = named("test_anonymous_visitor_cannot_publish");
    const traffic = new Run(run.root, run.createdAt, run.language, run.runtime, run.backend, run.topology, run.catalog, [refused, refused, refused, named("test_author_publishes_a_tagged_article")], run.problems);

    const articles = buildRouteMap(traffic).routes.find((route) => route.label === "POST /api/articles")!;
    expect(articles.variants.map((variant) => `×${variant.requests.length} ${how(variant)}`)).toEqual([
      "×1 main path",
      "×3 never reached the handler; ran JWTAuthentication.authenticate, core_exception_handler, ConduitJSONRenderer.render",
    ]);
  });

  test("only requests sent in the phases shown count, as on the graph", async () => {
    const run = await loadFixtureRun("go-shop-running");

    // Every request here was sent while a scenario ran (call phase); setup sent none.
    const setupOnly = buildRouteMap(run, { phases: [Phase.Setup] });
    expect({ routes: setupOnly.routes.length, withoutRequests: setupOnly.scenariosWithoutRequests }).toEqual({ routes: 0, withoutRequests: run.scenarios.length });
  });
});

describe("diffRouteMaps", () => {
  async function diff(app: FixtureApp) {
    const files = fixtureFiles(app);
    const base = (await loadPreviousRun(files))!;
    const head = await loadLatestRun(files);
    return renderDiff(diffRouteMaps(base, head, { moves: detectMoves(base, head) }));
  }

  test("a refactor: the article routes now take a new path, and the old one is gone", async () => {
    expect(await diff("fastapi-slug-refactor")).toMatchInlineSnapshot(`
      "POST /api/articles: changed
        changed 1→1: now calls ensure_slug_available, _normalize_title; no longer calls nothing [test_user_can_create_article]
        changed 1→1: now calls ensure_slug_available, _normalize_title; no longer calls nothing [test_user_can_not_create_article_with_duplicated_slug]
      GET /api/articles/feed: unchanged (1 variant(s))
      POST /api/users: unchanged (1 variant(s))"
    `);
  });

  test("a changed variant's path marks what it now runs and what it no longer runs, in place", async () => {
    const files = fixtureFiles("fastapi-slug-refactor");
    const base = (await loadPreviousRun(files))!;
    const head = await loadLatestRun(files);
    const created = diffRouteMaps(base, head, { moves: detectMoves(base, head) }).routes[0]!.variants[0]!;

    const marks = { [Op.Same]: " ", [Op.Added]: "+", [Op.Removed]: "-" };
    expect(created.path.slice(0, 6).map(({ op, step }) => `${marks[op]} ${"  ".repeat(step.depth)}${step.label}`)).toEqual([
      "  create_new_article",
      "+   ensure_slug_available",
      "      get_slug_for_article",
      "+       _normalize_title",
      "      check_article_exists",
      "        ArticlesRepository.get_article_by_slug",
    ]);
  });

  test("a fix to the feed: its route's variant changes, the others are untouched", async () => {
    expect(await diff("django-feed-fix")).toMatchInlineSnapshot(`
      "POST /api/users: unchanged (1 variant(s))
      POST /api/users/login: unchanged (1 variant(s))
      GET /api/user: unchanged (1 variant(s))
      POST /api/articles: unchanged (2 variant(s))
      GET /api/articles: unchanged (1 variant(s))
      POST /api/articles/{article_slug}/favorite: unchanged (1 variant(s))
      POST /api/articles/{article_slug}/comments: unchanged (1 variant(s))
      POST /api/profiles/{username}/follow: unchanged (1 variant(s))
      GET /api/articles/feed: added
        added 0→1: main path [test_follower_sees_followed_authors_in_their_feed]
      GET /api/articles/{slug}: removed
        removed 1→0: main path [test_follower_sees_followed_authors_in_their_feed]"
    `);
  });
});
