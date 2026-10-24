/**
 * The viewer's view models, built from real traces of the two example apps
 * (packages/trace/test/fixtures, recorded by examples/record.sh). Each test renders a view as plain text
 * so the snapshot reads as a description of the app, and a reviewer can check it by eye.
 */
import { describe, expect, test } from "vitest";

import { Phase, pythonSymbol, SystemGraph } from "@runshape/trace";
import { buildComponentView } from "../src";
import { buildFunctionView, FunctionView } from "../src";
import { buildReplay } from "../src";
import { buildSystemGraph } from "@runshape/architecture";
import { loadFixtureRun } from "../../trace/test/fixtures";

function describeGraph(graph: SystemGraph): string {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const nodes = graph.nodes
    .map((node) => `${node.zone.padEnd(17)}${node.label}${node.smells.length ? `  !${node.smells.join(",")}` : ""}`)
    .sort();
  const edges = graph.edges.map((edge) => `${label.get(edge.from)} -> ${label.get(edge.to)}  x${edge.calls}`).sort();
  return [...nodes, "", ...edges].join("\n");
}

function describeFunction(view: FunctionView): string {
  const rows = view.lines.map((line) => {
    const wires = line.executable ? `${String(line.scenarioIds.length).padStart(2)} tests` : "        ";
    return `${String(line.number).padStart(4)} ${wires} | ${line.text}`;
  });
  return [...rows, "", `untested lines: ${view.untestedLines.join(", ") || "none"}`].join("\n");
}

describe("system graph", () => {
  test("django: a request passes the client, the middleware chain and the router before reaching views", async () => {
    const run = await loadFixtureRun("django");

    // Django ORM models and DRF serializers query the database themselves, so they land in
    // the outbound-adapter zone, and every view that queries directly is flagged: in an
    // onion the handler would go through the core instead.
    expect(describeGraph(buildSystemGraph(run))).toMatchInlineSnapshot(`
      "core             ProfileSerializer
      core             RegistrationSerializer
      core             User
      core             articles.signals
      core             core.utils
      edge             AuthenticationMiddleware
      edge             Client (tests)
      edge             ClientHandler
      edge             CommonMiddleware
      edge             CorsMiddleware
      edge             CsrfViewMiddleware
      edge             MessageMiddleware
      edge             SecurityMiddleware
      edge             SessionMiddleware
      edge             URLResolver
      edge             XFrameOptionsMiddleware
      external         sqlite
      inbound-adapter  ArticleJSONRenderer
      inbound-adapter  ArticleViewSet  !touches-external
      inbound-adapter  ArticlesFavoriteAPIView  !touches-external
      inbound-adapter  CommentJSONRenderer
      inbound-adapter  CommentsListCreateAPIView  !touches-external
      inbound-adapter  JWTAuthentication  !touches-external
      inbound-adapter  LoginAPIView
      inbound-adapter  ProfileFollowAPIView  !touches-external
      inbound-adapter  ProfileJSONRenderer
      inbound-adapter  RegistrationAPIView  !touches-external
      inbound-adapter  UserJSONRenderer
      inbound-adapter  UserRetrieveUpdateAPIView  !touches-external
      inbound-adapter  core.exceptions
      outbound-adapter ArticleSerializer
      outbound-adapter CommentSerializer
      outbound-adapter LoginSerializer
      outbound-adapter Profile
      outbound-adapter TagRelatedField
      outbound-adapter UserManager
      outbound-adapter authentication.signals

      ArticleSerializer -> Profile  x6
      ArticleSerializer -> articles.signals  x5
      ArticleSerializer -> sqlite  x18
      ArticleViewSet -> ArticleSerializer  x29
      ArticleViewSet -> ProfileSerializer  x12
      ArticleViewSet -> TagRelatedField  x13
      ArticleViewSet -> sqlite  x14
      ArticlesFavoriteAPIView -> ArticleSerializer  x4
      ArticlesFavoriteAPIView -> Profile  x1
      ArticlesFavoriteAPIView -> ProfileSerializer  x2
      ArticlesFavoriteAPIView -> TagRelatedField  x1
      ArticlesFavoriteAPIView -> sqlite  x5
      AuthenticationMiddleware -> MessageMiddleware  x24
      Client (tests) -> ClientHandler  x24
      ClientHandler -> SecurityMiddleware  x24
      CommentSerializer -> sqlite  x1
      CommentsListCreateAPIView -> CommentSerializer  x3
      CommentsListCreateAPIView -> ProfileSerializer  x2
      CommentsListCreateAPIView -> sqlite  x2
      CommonMiddleware -> CsrfViewMiddleware  x24
      CommonMiddleware -> URLResolver  x1
      CorsMiddleware -> CommonMiddleware  x24
      CsrfViewMiddleware -> AuthenticationMiddleware  x24
      JWTAuthentication -> sqlite  x11
      LoginAPIView -> LoginSerializer  x1
      LoginSerializer -> User  x1
      LoginSerializer -> sqlite  x1
      MessageMiddleware -> XFrameOptionsMiddleware  x24
      Profile -> sqlite  x17
      ProfileFollowAPIView -> Profile  x2
      ProfileFollowAPIView -> ProfileSerializer  x4
      ProfileFollowAPIView -> sqlite  x6
      ProfileSerializer -> Profile  x8
      RegistrationAPIView -> RegistrationSerializer  x10
      RegistrationAPIView -> User  x10
      RegistrationAPIView -> sqlite  x20
      RegistrationSerializer -> UserManager  x10
      SecurityMiddleware -> SessionMiddleware  x24
      SessionMiddleware -> CorsMiddleware  x24
      TagRelatedField -> sqlite  x24
      UserManager -> authentication.signals  x10
      UserManager -> sqlite  x10
      UserRetrieveUpdateAPIView -> User  x1
      UserRetrieveUpdateAPIView -> sqlite  x1
      XFrameOptionsMiddleware -> ArticleJSONRenderer  x9
      XFrameOptionsMiddleware -> ArticleViewSet  x7
      XFrameOptionsMiddleware -> ArticlesFavoriteAPIView  x1
      XFrameOptionsMiddleware -> CommentJSONRenderer  x1
      XFrameOptionsMiddleware -> CommentsListCreateAPIView  x1
      XFrameOptionsMiddleware -> JWTAuthentication  x24
      XFrameOptionsMiddleware -> LoginAPIView  x1
      XFrameOptionsMiddleware -> ProfileFollowAPIView  x2
      XFrameOptionsMiddleware -> ProfileJSONRenderer  x2
      XFrameOptionsMiddleware -> RegistrationAPIView  x10
      XFrameOptionsMiddleware -> URLResolver  x24
      XFrameOptionsMiddleware -> UserJSONRenderer  x12
      XFrameOptionsMiddleware -> UserRetrieveUpdateAPIView  x1
      XFrameOptionsMiddleware -> core.exceptions  x3
      articles.signals -> core.utils  x5
      authentication.signals -> sqlite  x10"
    `);
  });

  test("fastapi: routes and dependencies are inbound, repositories outbound, the fake pool a test double", async () => {
    const run = await loadFixtureRun("fastapi");
    const graph = buildSystemGraph(run);

    expect(graph.nodes.map((node) => `${node.zone.padEnd(17)}${node.label}`).sort()).toMatchInlineSnapshot(`
      [
        "core             DateTimeModelMixin",
        "core             UserInDB",
        "core             domain.rwmodel",
        "core             services.articles",
        "core             services.authentication",
        "core             services.jwt",
        "core             services.security",
        "edge             APIRouter",
        "edge             CORSMiddleware",
        "edge             Client (tests)",
        "edge             ExceptionMiddleware",
        "edge             FastAPI",
        "edge             ServerErrorMiddleware",
        "external         postgres",
        "inbound-adapter  RWAPIKeyHeader",
        "inbound-adapter  articles.articles_common",
        "inbound-adapter  articles.articles_resource",
        "inbound-adapter  dependencies.authentication",
        "inbound-adapter  dependencies.database",
        "inbound-adapter  errors.http_error",
        "inbound-adapter  routes.authentication",
        "outbound-adapter ArticlesRepository",
        "outbound-adapter ProfilesRepository",
        "outbound-adapter TagsRepository",
        "outbound-adapter UsersRepository",
        "test-double      FakeAsyncPGPool",
        "test-double      FakePoolAcquireContent",
      ]
    `);
  });

  test("an app with a single route module still treats its dependencies as inbound adapters", async () => {
    const run = await loadFixtureRun("fastapi");
    const onlyUserRoutes = (run.topology?.routes ?? []).filter((route) => route.handler.text.startsWith("app.api.routes.users."));
    const singleModuleRun = Object.assign(Object.create(Object.getPrototypeOf(run)), run, {
      topology: { ...run.topology, routes: onlyUserRoutes },
    });

    const zones = new Map(buildSystemGraph(singleModuleRun).nodes.map((node) => [node.label, node.zone]));

    expect(onlyUserRoutes.length).toBeGreaterThan(0);
    expect(zones.get("dependencies.authentication")).toBe("inbound-adapter");
    expect(zones.get("dependencies.database")).toBe("inbound-adapter");
  });

  test("including the setup phase adds what the fixtures did: app startup and seeding data", async () => {
    const run = await loadFixtureRun("fastapi");

    const testBodyOnly = buildSystemGraph(run);
    const withSetup = buildSystemGraph(run, { phases: [Phase.Setup, Phase.Call] });

    const added = withSetup.nodes.filter((node) => !testBodyOnly.nodes.some((n) => n.id === node.id));
    expect(added.map((node) => node.label).sort()).toMatchInlineSnapshot(`
      [
        "TestAppSettings",
        "app.main",
        "core.events",
        "db.events",
      ]
    `);
  });
});

describe("component view", () => {
  test("lists a class's own methods, plus base-class methods that ran on its objects", async () => {
    const run = await loadFixtureRun("fastapi");

    const view = buildComponentView(run, "class:app.db.repositories.users.UsersRepository");

    expect(
      view.functions.map(
        (fn) =>
          `${fn.name.padEnd(24)} ${String(fn.coveredLines).padStart(2)}/${String(fn.executableLines).padEnd(2)} lines` +
          `  ${String(fn.scenarioIds.length).padStart(2)} tests${fn.inheritedFrom ? `  (from ${fn.inheritedFrom})` : ""}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "get_user_by_email         4/4  lines   1 tests",
        "get_user_by_username      7/7  lines   4 tests",
        "create_user              10/10 lines   4 tests",
        "update_user               0/18 lines   0 tests",
        "__init__                  1/1  lines   4 tests  (from BaseRepository)",
        "connection                1/1  lines   4 tests  (from BaseRepository)",
      ]
    `);
  });
});

describe("component view: nested code", () => {
  test("comprehensions inside a method are part of that method, not listed as methods of their own", async () => {
    const run = await loadFixtureRun("fastapi");

    const view = buildComponentView(run, "class:app.db.repositories.articles.ArticlesRepository");

    expect(view.functions.filter((fn) => fn.symbol.path.includes("<locals>"))).toEqual([]);
    expect(view.functions.map((fn) => fn.name)).toContain("get_tags_for_article_by_slug");
  });
});

describe("function view", () => {
  test("shows which tests reach each line, and which lines no test reaches", async () => {
    const run = await loadFixtureRun("fastapi");
    const source = await readFixtureSource("fastapi", "app/api/dependencies/authentication.py");

    const view = buildFunctionView(run, pythonSymbol("app.api.dependencies.authentication", "_get_current_user"), source);

    // The fixture's scenarios all send a valid token for an existing user, so neither
    // failure branch (unknown user, bad token) is reached.
    expect(describeFunction(view)).toMatchInlineSnapshot(`
      "  78          | async def _get_current_user(
        79          |     users_repo: UsersRepository = Depends(get_repository(UsersRepository)),
        80          |     token: str = Depends(_get_authorization_header_retriever()),
        81          |     settings: AppSettings = Depends(get_app_settings),
        82          | ) -> User:
        83  3 tests |     try:
        84  3 tests |         username = jwt.get_username_from_token(
        85  3 tests |             token,
        86  3 tests |             str(settings.secret_key.get_secret_value()),
        87          |         )
        88  0 tests |     except ValueError:
        89  0 tests |         raise HTTPException(
        90  0 tests |             status_code=status.HTTP_403_FORBIDDEN,
        91  0 tests |             detail=strings.MALFORMED_PAYLOAD,
        92          |         )
        93          | 
        94  3 tests |     try:
        95  3 tests |         return await users_repo.get_user_by_username(username=username)
        96  0 tests |     except EntityDoesNotExist:
        97  0 tests |         raise HTTPException(
        98  0 tests |             status_code=status.HTTP_403_FORBIDDEN,
        99  0 tests |             detail=strings.MALFORMED_PAYLOAD,

      untested lines: 88, 89, 90, 91, 96, 97, 98, 99"
    `);
  });

  test("groups tests that took exactly the same path through a function", async () => {
    const run = await loadFixtureRun("django");

    const view = buildFunctionView(run, pythonSymbol("conduit.apps.authentication.backends", "JWTAuthentication.authenticate"), null);

    expect(view.samePathGroups.map((group) => group.map((id) => id.split("::")[1]))).toMatchInlineSnapshot(`
      [
        [
          "test_visitor_registers_an_account",
          "test_anonymous_visitor_cannot_publish",
        ],
        [
          "test_member_logs_in_and_reads_their_profile",
          "test_author_publishes_a_tagged_article",
          "test_reader_browses_articles_by_tag",
          "test_reader_favorites_and_comments_on_an_article",
          "test_reader_follows_an_author",
          "test_follower_sees_followed_authors_in_their_feed",
        ],
      ]
    `);
  });
});

describe("replay", () => {
  test("an anonymous publish attempt: in through the middleware, rejected before any view code runs", async () => {
    const run = await loadFixtureRun("django");
    const scenario = run.scenario("tests/test_user_journeys.py::test_anonymous_visitor_cannot_publish");

    const steps = buildReplay(scenario!).map(
      (step) => `${step.kind.padEnd(8)} ${shortId(step.from)} -> ${shortId(step.to)}: ${step.label.slice(0, 60)}`,
    );

    expect(steps).toMatchInlineSnapshot(`
      [
        "call     client -> ClientHandler: POST /api/articles",
        "call     ClientHandler -> SecurityMiddleware: SecurityMiddleware",
        "call     SecurityMiddleware -> SessionMiddleware: SessionMiddleware",
        "call     SessionMiddleware -> CorsMiddleware: CorsMiddleware",
        "call     CorsMiddleware -> CommonMiddleware: CommonMiddleware",
        "call     CommonMiddleware -> CsrfViewMiddleware: CsrfViewMiddleware",
        "call     CsrfViewMiddleware -> AuthenticationMiddleware: AuthenticationMiddleware",
        "call     AuthenticationMiddleware -> MessageMiddleware: MessageMiddleware",
        "call     MessageMiddleware -> XFrameOptionsMiddleware: XFrameOptionsMiddleware",
        "call     XFrameOptionsMiddleware -> URLResolver: URLResolver",
        "return   URLResolver -> XFrameOptionsMiddleware: URLResolver",
        "call     XFrameOptionsMiddleware -> JWTAuthentication: JWTAuthentication.authenticate",
        "return   JWTAuthentication -> XFrameOptionsMiddleware: JWTAuthentication.authenticate",
        "call     XFrameOptionsMiddleware -> exceptions: core_exception_handler",
        "return   exceptions -> XFrameOptionsMiddleware: core_exception_handler",
        "call     XFrameOptionsMiddleware -> ArticleJSONRenderer: ConduitJSONRenderer.render",
        "return   ArticleJSONRenderer -> XFrameOptionsMiddleware: ConduitJSONRenderer.render",
        "return   XFrameOptionsMiddleware -> MessageMiddleware: XFrameOptionsMiddleware",
        "return   MessageMiddleware -> AuthenticationMiddleware: MessageMiddleware",
        "return   AuthenticationMiddleware -> CsrfViewMiddleware: AuthenticationMiddleware",
        "return   CsrfViewMiddleware -> CommonMiddleware: CsrfViewMiddleware",
        "return   CommonMiddleware -> CorsMiddleware: CommonMiddleware",
        "return   CorsMiddleware -> SessionMiddleware: CorsMiddleware",
        "return   SessionMiddleware -> SecurityMiddleware: SessionMiddleware",
        "return   SecurityMiddleware -> ClientHandler: SecurityMiddleware",
        "return   ClientHandler -> client: POST /api/articles",
      ]
    `);
  });
});

function shortId(componentId: string): string {
  return componentId.split(/[.:]/).pop() ?? componentId;
}

/** A copy of the example's source, checked in beside its trace so the test stands alone. */
async function readFixtureSource(app: "django" | "fastapi", file: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const text = await readFile(join(import.meta.dirname, "..", "..", "trace", "test", "fixtures", app, "source", file), "utf8");
  return text.split("\n");
}

describe("grouping", () => {
  test("collapsing middleware turns the chain into one box, in the graph and in the replay alike", async () => {
    const run = await loadFixtureRun("django");
    const grouping = { collapseMiddleware: true };
    const scenario = run.scenario("tests/test_user_journeys.py::test_anonymous_visitor_cannot_publish")!;

    const graph = buildSystemGraph(run, { grouping });
    const steps = buildReplay(scenario, [Phase.Call], grouping);

    expect(graph.nodes.filter((node) => node.kind === "middleware").map((node) => node.label)).toEqual(["Middleware ×8"]);
    // Every replay hop must run along an edge the graph actually drew.
    const edgeIds = new Set(graph.edges.map((edge) => edge.id));
    expect(steps.filter((step) => !edgeIds.has(step.edgeId))).toEqual([]);
    expect(steps.map((step) => `${step.kind} ${shortId(step.from)} -> ${shortId(step.to)}`)).toMatchInlineSnapshot(`
      [
        "call client -> ClientHandler",
        "call ClientHandler -> middleware-chain",
        "call middleware-chain -> URLResolver",
        "return URLResolver -> middleware-chain",
        "call middleware-chain -> JWTAuthentication",
        "return JWTAuthentication -> middleware-chain",
        "call middleware-chain -> exceptions",
        "return exceptions -> middleware-chain",
        "call middleware-chain -> ArticleJSONRenderer",
        "return ArticleJSONRenderer -> middleware-chain",
        "return middleware-chain -> ClientHandler",
        "return ClientHandler -> client",
      ]
    `);
  });
});
