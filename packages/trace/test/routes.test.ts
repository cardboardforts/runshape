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

import { CodeSymbol, FunctionInfo, Outcome, Phase, QualifiedName, Role, Run, Scenario, Span, SymbolKind } from "@runshape/core";
import { buildRouteMap, Change, Op, detectMoves, diffRouteMaps, readablePattern, RouteMap, RouteMapDiff, routeForPath, RouteVariant } from "../src";
import { FixtureApp, fixtureRuns, loadFixtureRun } from "../../core/test/fixtures";

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
            Handler.ServeHTTP
              Handler.getOrder
                Service.Get
                  MemoryRepository.Find
                writeJSON
                  statusRecorder.WriteHeader
        ×1 adds Order.TotalCents [GET /orders/ord-1 #3]
            Handler.ServeHTTP
              Handler.getOrder
                Service.Get
                  MemoryRepository.Find
                Order.TotalCents
                writeJSON
                  statusRecorder.WriteHeader
      POST /orders: 3 request(s)
        ×1 main path [POST /orders #2]
            Handler.ServeHTTP
              Handler.placeOrder
                Service.Place
                  Order.Problems
                  MemoryRepository.Save
                writeJSON
                  statusRecorder.WriteHeader
        ×1 skips MemoryRepository.Save [POST /orders #4]
            Handler.ServeHTTP
              Handler.placeOrder
                Service.Place
                  Order.Problems
                writeJSON
                  statusRecorder.WriteHeader
        ×1 skips Service.Place, Order.Problems, MemoryRepository.Save [POST /orders #5]
            Handler.ServeHTTP
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
            _get_db_pool
            _get_connection_from_pool
            get_repository.<locals>._get_repo
              BaseRepository.__init__
            RWAPIKeyHeader.__call__
            _get_authorization_header
            _get_current_user
              get_username_from_token
              UsersRepository.get_user_by_username
                BaseRepository.connection
                postgres asyncpg.connection.Connection.fetchrow
                DateTimeModelMixin.default_datetime (repeats)
            get_repository.<locals>._get_repo
              ArticlesRepository.__init__
                BaseRepository.__init__
                ProfilesRepository.__init__
                  BaseRepository.__init__ (repeats)
                BaseRepository.__init__
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
            DateTimeModelMixin.default_datetime (repeats)
            convert_datetime_to_realworld (repeats)
        ×1 skips ArticlesRepository.create_article, postgres asyncpg.connection.Connection.execute, ProfilesRepository.is_user_following_for_another_user, ArticlesRepository.is_article_favorited_by_user, convert_datetime_to_realworld; adds http_error_handler [test_user_can_not_create_article_with_duplicated_slug]
            _get_db_pool
            _get_connection_from_pool
            get_repository.<locals>._get_repo
              BaseRepository.__init__
            RWAPIKeyHeader.__call__
            _get_authorization_header
            _get_current_user
              get_username_from_token
              UsersRepository.get_user_by_username
                BaseRepository.connection
                postgres asyncpg.connection.Connection.fetchrow
                DateTimeModelMixin.default_datetime (repeats)
            get_repository.<locals>._get_repo
              ArticlesRepository.__init__
                BaseRepository.__init__
                ProfilesRepository.__init__
                  BaseRepository.__init__ (repeats)
                BaseRepository.__init__
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
            http_error_handler
      GET /api/articles/feed: 1 request(s)
        ×1 main path [test_empty_feed_if_user_has_not_followings]
            _get_db_pool
            _get_connection_from_pool
            get_repository.<locals>._get_repo
              BaseRepository.__init__
            RWAPIKeyHeader.__call__
            _get_authorization_header
            _get_current_user
              get_username_from_token
              UsersRepository.get_user_by_username
                BaseRepository.connection
                postgres asyncpg.connection.Connection.fetchrow
                DateTimeModelMixin.default_datetime (repeats)
            get_repository.<locals>._get_repo
              ArticlesRepository.__init__
                BaseRepository.__init__
                ProfilesRepository.__init__
                  BaseRepository.__init__ (repeats)
                BaseRepository.__init__
            get_articles_for_user_feed
              ArticlesRepository.get_articles_for_user_feed
                BaseRepository.connection
                postgres asyncpg.connection.Connection.fetch
                ArticlesRepository.get_articles_for_user_feed.<locals>.<listcomp>
              get_articles_for_user_feed.<locals>.<listcomp>
      POST /api/users: 1 request(s)
        ×1 main path [test_user_success_registration]
            _get_db_pool
            _get_connection_from_pool
            get_repository.<locals>._get_repo
              BaseRepository.__init__
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
            JWTAuthentication.authenticate
            RegistrationAPIView.post
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              RegistrationSerializer.create
                UserManager.create_user
                  sqlite django.db.backends.utils.CursorWrapper.execute
                  create_related_profile
                    sqlite django.db.backends.utils.CursorWrapper.execute
              User.token
                User._generate_jwt_token
            UserJSONRenderer.render
              ConduitJSONRenderer.render
      POST /api/users/login: 1 request(s)
        ×1 main path [test_member_logs_in_and_reads_their_profile]
            JWTAuthentication.authenticate
            LoginAPIView.post
              LoginSerializer.validate
                sqlite django.db.backends.utils.CursorWrapper.execute
                User.token
                  User._generate_jwt_token
            UserJSONRenderer.render
              ConduitJSONRenderer.render
      GET /api/user: 1 request(s)
        ×1 main path [test_member_logs_in_and_reads_their_profile]
            JWTAuthentication.authenticate
              JWTAuthentication._authenticate_credentials
                sqlite django.db.backends.utils.CursorWrapper.execute
            UserRetrieveUpdateAPIView.retrieve
              User.token
                User._generate_jwt_token
              sqlite django.db.backends.utils.CursorWrapper.execute
            UserJSONRenderer.render
              ConduitJSONRenderer.render
      POST /api/articles: 6 request(s)
        ×5 main path [test_author_publishes_a_tagged_article, test_reader_browses_articles_by_tag, test_reader_browses_articles_by_tag, test_reader_favorites_and_comments_on_an_article, test_follower_sees_followed_authors_in_their_feed]
            JWTAuthentication.authenticate
              JWTAuthentication._authenticate_credentials
                sqlite django.db.backends.utils.CursorWrapper.execute
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
            ConduitJSONRenderer.render
        ×1 never reached the handler; ran core_exception_handler [test_anonymous_visitor_cannot_publish]
            JWTAuthentication.authenticate
            core_exception_handler
            ConduitJSONRenderer.render
      GET /api/articles: 1 request(s)
        ×1 main path [test_reader_browses_articles_by_tag]
            JWTAuthentication.authenticate
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
            ConduitJSONRenderer.render
      POST /api/articles/{article_slug}/favorite: 1 request(s)
        ×1 main path [test_reader_favorites_and_comments_on_an_article]
            JWTAuthentication.authenticate
              JWTAuthentication._authenticate_credentials
                sqlite django.db.backends.utils.CursorWrapper.execute
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
            ConduitJSONRenderer.render
      POST /api/articles/{article_slug}/comments: 1 request(s)
        ×1 main path [test_reader_favorites_and_comments_on_an_article]
            JWTAuthentication.authenticate
              JWTAuthentication._authenticate_credentials
                sqlite django.db.backends.utils.CursorWrapper.execute
            CommentsListCreateAPIView.create
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              CommentSerializer.create
                sqlite django.db.backends.utils.CursorWrapper.execute
              ProfileSerializer.get_image
              ProfileSerializer.get_following
              CommentSerializer.get_created_at
              CommentSerializer.get_updated_at
            ConduitJSONRenderer.render
      POST /api/profiles/{username}/follow: 2 request(s)
        ×2 main path [test_reader_follows_an_author, test_follower_sees_followed_authors_in_their_feed]
            JWTAuthentication.authenticate
              JWTAuthentication._authenticate_credentials
                sqlite django.db.backends.utils.CursorWrapper.execute
            ProfileFollowAPIView.post
              sqlite django.db.backends.utils.CursorWrapper.execute (repeats)
              Profile.follow
                sqlite django.db.backends.utils.CursorWrapper.execute
              sqlite django.db.backends.utils.CursorWrapper.execute
              ProfileSerializer.get_image
              ProfileSerializer.get_following
                Profile.is_following
                  sqlite django.db.backends.utils.CursorWrapper.execute
            ConduitJSONRenderer.render
      GET /api/articles/{slug}: 1 request(s)
        ×1 main path [test_follower_sees_followed_authors_in_their_feed]
            JWTAuthentication.authenticate
              JWTAuthentication._authenticate_credentials
                sqlite django.db.backends.utils.CursorWrapper.execute
            ArticleViewSet.retrieve
              sqlite django.db.backends.utils.CursorWrapper.execute
            core_exception_handler
              _handle_not_found_error
            ConduitJSONRenderer.render"
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
      "×3 never reached the handler; ran core_exception_handler",
    ]);
  });

  test("a view class's own hook running before the handler doesn't stand in for it (second-model review)", async () => {
    // Stage it on real data: every request's authentication step becomes a hook of
    // ArticleViewSet, as an overridden get_permissions would be. It runs first in every
    // request, registration and login included; it must not pull them into the article routes.
    const run = await loadFixtureRun("django");
    const before = render(buildRouteMap(run)).split("\n").filter((line) => !line.startsWith(" "));
    const hook = new CodeSymbol(["conduit", "apps", "articles", "views"], ["ArticleViewSet"], "get_permissions", SymbolKind.Method, "ArticleViewSet");
    for (const scenario of run.scenarios) {
      for (const span of scenario.spans) {
        if (span.fn.symbol.localName.text === "JWTAuthentication.authenticate") (span as { fn: FunctionInfo }).fn = { ...span.fn, symbol: hook };
      }
    }

    expect(render(buildRouteMap(run)).split("\n").filter((line) => !line.startsWith(" "))).toEqual(before);
  });

  test("no route in the table: requests group by their literal path", async () => {
    const run = await loadFixtureRun("go-shop-running");
    const untabled = new Run(run.root, run.createdAt, run.language, run.runtime, run.backend, { ...run.topology!, routes: [] }, run.catalog, run.scenarios, run.problems);

    expect(buildRouteMap(untabled).routes.map((route) => `${route.label} routed=${route.routed} ×${route.requestCount}`)).toEqual([
      "GET /orders/warmup routed=false ×1",
      "POST /orders routed=false ×3",
      "GET /orders/ord-1 routed=false ×1",
      "GET /orders/ord-42 routed=false ×1",
    ]);
  });

  test("patterns, every framework's way, and which one a path matches", () => {
    expect(
      [
        "/api/^^articles/(?P<slug>[^/.]+)", // Django REST router
        "^articles/(?P<slug>[-\\w]+)/?$", // a raw Django regex: "$" then "/?"
        "/admin/r/<path:content_type_id>/<path:object_id>/", // Django path converters
        "/api/articles/{slug}", // FastAPI
        "/orders/{$}", // Go's exact-match marker
      ].map(readablePattern),
    ).toEqual(["/api/articles/{slug}", "articles/{slug}", "/admin/r/{content_type_id}/{object_id}/", "/api/articles/{slug}", "/orders/"]);

    const route = (path: string) => ({ methods: ["GET"], path, handler: QualifiedName.parse(`h.${path}`) });
    const table = [route("/orders/{id}"), route("/orders/new"), route("/files/{path...}"), route("/orders/{id}/items")];
    const matched = (path: string) => routeForPath(table, path)?.path ?? null;
    // Go's mux: the most specific pattern wins, wherever it's listed.
    expect(["/orders/new", "/orders/ord-1", "/files/a/b/c", "/files", "/orders/ord-1/items", "/orders/ord-1/items/2"].map(matched)).toEqual([
      "/orders/new",
      "/orders/{id}",
      "/files/{path...}",
      "/files/{path...}",
      "/orders/{id}/items",
      null,
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
    const runs = fixtureRuns(app);
    const base = (await runs.previous())!;
    const head = await runs.latest();
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
    const runs = fixtureRuns("fastapi-slug-refactor");
    const base = (await runs.previous())!;
    const head = await runs.latest();
    const created = diffRouteMaps(base, head, { moves: detectMoves(base, head) }).routes[0]!.variants[0]!;

    const marks = { [Op.Same]: " ", [Op.Added]: "+", [Op.Removed]: "-" };
    // FastAPI's dependencies (the pool, the repositories, the API key header) run first and
    // didn't change; the handler is where the refactor shows.
    const handler = created.path.findIndex(({ step }) => step.label === "create_new_article");
    expect(created.path.slice(handler, handler + 6).map(({ op, step }) => `${marks[op]} ${"  ".repeat(step.depth)}${step.label}`)).toEqual([
      "  create_new_article",
      "+   ensure_slug_available",
      "      get_slug_for_article",
      "+       _normalize_title",
      "      check_article_exists",
      "        ArticlesRepository.get_article_by_slug",
    ]);
  });

  test("read backwards, the refactor's variants no longer call what it added", async () => {
    const runs = fixtureRuns("fastapi-slug-refactor");
    const base = (await runs.previous())!;
    const head = await runs.latest();

    const undone = diffRouteMaps(head, base).routes[0]!.variants.map(({ change, nowCalls, noLongerCalls }) => ({ change, nowCalls, noLongerCalls }));
    expect(undone).toEqual([
      { change: Change.Changed, nowCalls: [], noLongerCalls: ["ensure_slug_available", "_normalize_title"] },
      { change: Change.Changed, nowCalls: [], noLongerCalls: ["ensure_slug_available", "_normalize_title"] },
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

/**
 * Shapes the example recordings don't happen to contain, built by hand: a call tree is written
 * "name(child, child)", each request one tree under its entry, every function in package "app"
 * unless written "pkg:name".
 */
describe("shapes the recordings don't have", () => {
  const ROUTE = { methods: ["POST"], path: "/orders", handler: QualifiedName.parse("app.place") };

  function request(nodeid: string, tree: string): Scenario {
    const spans: Span[] = [];
    let clock = 0;
    const open = (name: string, parent: Span | null): Span => {
      const [pkg, fn] = name.includes(":") ? name.split(":") : ["app", name];
      const info: FunctionInfo = { role: Role.Source, symbol: new CodeSymbol([pkg!], [], fn!, SymbolKind.Function, null), file: null, firstLine: 1, landmarkKind: null };
      const span = new Span(spans.length + 1, info, parent, null, Phase.Call, (clock += 1), 1);
      spans.push(span);
      parent?.children.push(span);
      return span;
    };
    // A tiny parser for "a(b, c(d))".
    const tokens = tree.match(/[\w:]+|[(),]/g)!;
    let at = 0;
    const parse = (parent: Span | null): Span => {
      const span = open(tokens[at++]!, parent);
      if (tokens[at] === "(") {
        at += 1;
        while (tokens[at] !== ")") {
          parse(span);
          if (tokens[at] === ",") at += 1;
        }
        at += 1;
      }
      return span;
    };
    const entry = parse(null);
    entry.request = { method: "POST", path: "/orders" };
    return new Scenario(nodeid, Outcome.Passed, 0, spans, [], [], []);
  }

  const runOf = (...scenarios: Scenario[]) =>
    new Run("/app", "2026-10-14", "go", "go1", "instrument", { framework: "net/http", entry: "", middleware: [], router: null, routes: [ROUTE], externals: [] }, [], scenarios, []);

  test("a loop's iterations collapse into one step that shows it repeated, whichever iteration looped inside", () => {
    const map = buildRouteMap(runOf(request("t1", "serve(place(line(price), line(price, price)))")));

    expect(map.routes[0]!.variants[0]!.steps.map((step) => `${"  ".repeat(step.depth)}${step.label}${step.repeated ? " ↻" : ""}`)).toEqual([
      "serve",
      "  place",
      "    line ↻",
      "      price ↻",
    ]);
  });

  test("two functions with one short name are different calls, told apart by their package", () => {
    const map = buildRouteMap(runOf(request("t1", "serve(place(json:encode))"), request("t1", "serve(place(json:encode))"), request("t2", "serve(place(xml:encode))")));

    expect(map.routes[0]!.variants.map((variant) => how(variant))).toEqual(["main path", "skips json.encode; adds xml.encode"]);
  });

  test("a request turned away is never the changed version of one that got through, however alike", () => {
    // Both ran the same authentication; only one reached the handler. Turned away now isn't
    // "the same way, changed": it's a way that's gone and one that's new.
    const before = runOf(request("t1", "serve(auth(token, user), place(save))"));
    const after = runOf(request("t1", "serve(auth(token, user), deny)"));

    expect(diffRouteMaps(before, after).routes[0]!.variants.map((variant) => `${variant.change} reached=${variant.variant.reachedHandler}`)).toEqual([
      "added reached=false",
      "removed reached=true",
    ]);
  });
});
