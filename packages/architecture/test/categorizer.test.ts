/**
 * The categorizer (docs/categorizer.md) on real recordings. Each item gets its kind from the
 * parser's facts, roles from its region's style (one per lens), and traits from what it did
 * while the tests ran. Every tag is a claim with evidence; the rules read only tags. The
 * snapshots print every claim so a reviewer can check each against the example app's code.
 */
import { describe, expect, test } from "vitest";

import { BoundaryCall, CodeSymbol, FunctionInfo, Outcome, Phase, QualifiedName, Role, Run, Scenario, Span, SymbolKind, TraceDirectory } from "@runshape/kernel";
import { CategorizedItem, Categorization, categorize, checkTagRules, failureOn, Finding, Kind, newFindings, ZoneRules } from "../src";
import { fixtureFiles, fixtureRuns } from "../../kernel/test/fixtures";

/** One line per item: kind/subkind name [region|style|zone] then lens=role(by confidence: evidence). */
function lines(categorization: Categorization, keep: (item: CategorizedItem) => boolean = () => true): string[] {
  return categorization.items.filter(keep).map((item) => {
    const tags = item.tags.map((tag) => `${tag.lens}=${tag.id} (${tag.by} ${tag.confidence}: ${tag.evidence.join("; ")})`);
    return `${item.kind}/${item.subkind} ${item.name} [${item.region}|${item.style}|${item.zone}]${tags.length > 0 ? `\n    ${tags.join("\n    ")}` : ""}`;
  });
}

function findingLines(findings: Finding[]): string[] {
  return findings.map((finding) => `${finding.severity} ${finding.rule}: ${finding.item} (${finding.zone}): ${finding.message}\n    ${finding.evidence.join("\n    ")}`);
}

/** go-shop as its README draws it: a web handler, an orders core, in-memory storage behind it. */
const GO_SHOP_RULES = {
  version: 2,
  style: "hexagonal",
  zones: [
    { match: "example\\.com.shop.internal.web.**", zone: "inbound-adapter", reason: "HTTP handlers", by: "user" },
    { match: "example\\.com.shop.internal.storage.**", zone: "outbound-adapter", reason: "stores orders", by: "user" },
    { match: "example\\.com.shop.internal.**", zone: "core", reason: "the shop's rules", by: "user" },
  ],
};

describe("categorize", () => {
  test("go-shop: roles from zones and routes, traits from source lines that ran, and what the trace can't say", async () => {
    const run = await fixtureRuns("go-shop").latest();

    const categorization = categorize(run, ZoneRules.parse(JSON.stringify(GO_SHOP_RULES)));

    expect(lines(categorization)).toMatchInlineSnapshot(`
      [
        "container/package example\\.com.shop.internal.app [|hexagonal|core]",
        "container/package example\\.com.shop.internal.orders [|hexagonal|core]",
        "container/package example\\.com.shop.internal.storage [|hexagonal|outbound-adapter]",
        "container/package example\\.com.shop.internal.web [|hexagonal|inbound-adapter]",
        "type/type example\\.com.shop.internal.orders.Order [|hexagonal|core]",
        "type/type example\\.com.shop.internal.orders.Service [|hexagonal|core]",
        "type/type example\\.com.shop.internal.storage.MemoryRepository [|hexagonal|outbound-adapter]
          ports-and-adapters=secondary-adapter (detected 0.9: placed in outbound-adapter by rule example\\.com.shop.internal.storage.** (user))
          tactical-ddd=repository (detected 0.6: its name matches *Repository)",
        "type/type example\\.com.shop.internal.web.Handler [|hexagonal|inbound-adapter]
          ports-and-adapters=primary-adapter (detected 0.95: placed in inbound-adapter by rule example\\.com.shop.internal.web.** (user); the framework routes POST /orders, GET /orders/{id} to it)",
        "type/type example\\.com.shop.internal.web.statusRecorder [|hexagonal|inbound-adapter]
          ports-and-adapters=primary-adapter (detected 0.9: placed in inbound-adapter by rule example\\.com.shop.internal.web.** (user))",
        "callable/function example\\.com.shop.internal.app.New [|hexagonal|core]
          effect=pure (detected 0.4: no boundary call or field write in 4 recorded calls)
          cqs=query (detected 0.7: returns a value (line 17); no recorded write)",
        "callable/function example\\.com.shop.internal.orders.NewService [|hexagonal|core]
          effect=pure (detected 0.4: no boundary call or field write in 4 recorded calls)
          cqs=query (detected 0.7: returns a value (line 26); no recorded write)",
        "callable/method example\\.com.shop.internal.orders.Order.Problems [|hexagonal|core]
          effect=pure (detected 0.4: no boundary call or field write in 2 recorded calls)
          cqs=query (detected 0.7: returns a value (line 56); no recorded write)",
        "callable/method example\\.com.shop.internal.orders.Order.TotalCents [|hexagonal|core]
          effect=pure (detected 0.4: no boundary call or field write in 2 recorded calls)
          cqs=query (detected 0.7: returns a value (line 36); no recorded write)",
        "callable/method example\\.com.shop.internal.orders.Service.Get [|hexagonal|core]
          effect=pure (detected 0.4: no boundary call or field write in 2 recorded calls)
          cqs=query (detected 0.7: returns a value (line 45); no recorded write)",
        "callable/method example\\.com.shop.internal.orders.Service.Place [|hexagonal|core]
          effect=writes-state (detected 0.85: writes field nextID (line 35); writes a field through example\\.com.shop.internal.storage.MemoryRepository.Save)
          cqs=both (detected 0.7: returns a value (line 33); writes field nextID (line 35))
          failure=can-fail (detected 0.6: fmt.Errorf at line 38, not run by the tests)",
        "callable/method example\\.com.shop.internal.storage.MemoryRepository.Find [|hexagonal|outbound-adapter]
          effect=pure (detected 0.4: no boundary call or field write in 2 recorded calls)
          cqs=query (detected 0.7: returns a value (line 35); no recorded write)",
        "callable/method example\\.com.shop.internal.storage.MemoryRepository.Save [|hexagonal|outbound-adapter]
          effect=writes-state (detected 0.85: writes field orders (line 25))
          cqs=command (detected 0.7: no executed return with a value: the return lines that ran hand back nothing; writes field orders (line 25))",
        "callable/function example\\.com.shop.internal.storage.NewMemoryRepository [|hexagonal|outbound-adapter]
          effect=pure (detected 0.4: no boundary call or field write in 4 recorded calls)
          cqs=query (detected 0.7: returns a value (line 18); no recorded write)",
        "callable/method example\\.com.shop.internal.web.Handler.ServeHTTP [|hexagonal|inbound-adapter]
          effect=writes-state (detected 0.85: writes a field through example\\.com.shop.internal.orders.Service.Place; writes a field through example\\.com.shop.internal.storage.MemoryRepository.Save; writes a field through example\\.com.shop.internal.web.statusRecorder.WriteHeader)",
        "callable/method example\\.com.shop.internal.web.Handler.getOrder [|hexagonal|inbound-adapter]
          ports-and-adapters=primary-adapter (detected 0.85: the framework routes GET /orders/{id} to it)
          effect=writes-state (detected 0.85: writes a field through example\\.com.shop.internal.web.statusRecorder.WriteHeader)",
        "callable/method example\\.com.shop.internal.web.Handler.placeOrder [|hexagonal|inbound-adapter]
          ports-and-adapters=primary-adapter (detected 0.85: the framework routes POST /orders to it)
          effect=writes-state (detected 0.85: writes a field through example\\.com.shop.internal.orders.Service.Place; writes a field through example\\.com.shop.internal.storage.MemoryRepository.Save; writes a field through example\\.com.shop.internal.web.statusRecorder.WriteHeader)",
        "callable/function example\\.com.shop.internal.web.NewHandler [|hexagonal|inbound-adapter]
          effect=pure (detected 0.4: no boundary call or field write in 4 recorded calls)
          cqs=query (detected 0.7: returns a value (line 28); no recorded write)",
        "callable/method example\\.com.shop.internal.web.statusRecorder.WriteHeader [|hexagonal|inbound-adapter]
          effect=writes-state (detected 0.85: writes field status (line 83))
          cqs=command (detected 0.7: no executed return with a value: the return lines that ran hand back nothing; writes field status (line 83))",
        "callable/function example\\.com.shop.internal.web.writeJSON [|hexagonal|inbound-adapter]
          effect=writes-state (detected 0.85: writes a field through example\\.com.shop.internal.web.statusRecorder.WriteHeader)",
      ]
    `);
    expect(categorization.missing).toMatchInlineSnapshot(`
      [
        "Types: a type appears only when one of its methods ran or an object of it was seen, and the trace doesn't say class, struct or interface; interfaces never run, so primary-port and secondary-port can only be judged by a model or declared.",
        "State: only object references set while constructing (an object's wires) are recorded; plain fields, constants and globals aren't, so state has no traits.",
        "Metadata: decorators, annotations and attributes aren't recorded, so none is categorized and none is used as evidence.",
        "Failure: exceptions aren't recorded per call; can-fail is read from raise, throw, panic or error-making lines in the source, and total is never claimed.",
        "Effect: clocks, randomness and in-memory reads aren't recorded, so pure means no recorded effect, not a proof.",
        "Intent (decision, orchestration) needs a model: it isn't detected.",
      ]
    `);
  });

  test("the CQRS example: on for a container by match, relaxed for a declared command handler, off in a region", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const withTaxonomy = (taxonomy: object, extra: object = {}) => ZoneRules.parse(JSON.stringify({ ...GO_SHOP_RULES, ...extra, taxonomy }));
    const cqrsOn = { rules: [{ id: "cqrs-no-mixed-callable", match: "example\\.com.shop.internal.orders.**" }] };
    const findings = (rules: ZoneRules) => findingLines(checkTagRules(categorize(run, rules), rules.taxonomy));

    const handler = { ...cqrsOn, roles: [{ match: "example\\.com.shop.internal.orders.Service.Place", role: "command-handler", reason: "returns the placement it made", by: "user" }] };
    const orders = { name: "orders", match: "example\\.com.shop.internal.orders.**", in: "core", style: "hexagonal", reason: "the shop's rules", by: "user", zones: [] };
    const offInOrders = { rules: [{ ...cqrsOn.rules[0], off_in: ["orders"] }] };

    expect({
      // Without it, no style implies CQRS, so Place mixing a write and a return is fine.
      off: findings(withTaxonomy({})),
      on: findings(withTaxonomy(cqrsOn)),
      relaxedForAHandler: findings(withTaxonomy(handler)),
      offInARegion: findings(withTaxonomy(offInOrders, { version: 3, regions: [orders] })),
    }).toMatchInlineSnapshot(`
      {
        "off": [],
        "offInARegion": [],
        "on": [
          "warn cqrs-no-mixed-callable: example\\.com.shop.internal.orders.Service.Place (core): changes state and returns a value (CQS)
          both: returns a value (line 33); writes field nextID (line 35)",
        ],
        "relaxedForAHandler": [],
      }
    `);
  });

  test("CQS counts a callable's own writes and stored state below it, not a callee's in-memory field: a memoizing getter doesn't make its callers 'both' (second-model review)", async () => {
    // On Runshape's own recording, QualifiedName.text caches its text in a field: counted
    // through callees, 62 callables read as "both". Staged on go-shop: Place keeps its returned
    // value but loses its own write (line 35, s.nextID++), so its only write is the in-memory
    // map MemoryRepository.Save fills below it.
    const files = fixtureFiles("go-shop");
    const staged = new TraceDirectory({
      async readText(path) {
        const text = await files.readText(path);
        if (!path.endsWith("manifest.json")) return text;
        const data = JSON.parse(text);
        data.sources["internal/orders/service.go"][34] = "\tnext := s.nextID + 1";
        return JSON.stringify(data);
      },
    });
    const rules = ZoneRules.parse(JSON.stringify(GO_SHOP_RULES));

    const place = categorize(await staged.latest(), rules).items.find((item) => item.name.endsWith("Service.Place"))!;

    expect(place.tags.filter((tag) => tag.lens === "effect" || tag.lens === "cqs").map((tag) => `${tag.lens}=${tag.id}: ${tag.evidence.join("; ")}`)).toEqual([
      "effect=writes-state: writes a field through example\\.com.shop.internal.storage.MemoryRepository.Save",
      "cqs=query: returns a value (line 33); no write of its own or to stored state (callees' in-memory fields don't count)",
    ]);
  });

  test("can-fail reads code, not strings or comments: a 'throw' in a message isn't a throw", () => {
    expect({
      typescript: ['throw new Error("x");', '  if (bad) throw new RulesError(problems);', 'log("never throw here");', "// throw later", "const x = y.throw;", "throwIfMissing(x);"].map((line) => failureOn("typescript", line)),
      python: ["    raise ValueError('x')", '    message = "raise it"', "    # raise later"].map((line) => failureOn("python", line)),
      go: ['\treturn fmt.Errorf("saving: %w", err)', '\tlog.Print("panic(") // not a panic', "\tpanic(err)"].map((line) => failureOn("go", line)),
    }).toEqual({
      typescript: ["throw", "throw", null, null, null, null],
      python: ["raise", null, null],
      go: ["fmt.Errorf", null, "panic"],
    });
  });

  test("a call deep in the stack is counted once: its query once, its calls once, however many callers sit above it", () => {
    // The first version walked every span's whole subtree from every span, so a call six deep
    // was counted six times: "postgres: SELECT ×6 itself" for one query. Evidence must be honest.
    const span = (id: number, namespace: string, name: string, parent: Span | null, role = Role.Source) => {
      const fn: FunctionInfo = { role, symbol: new CodeSymbol(["app", namespace], [], name, SymbolKind.Function, null), file: null, firstLine: 1, landmarkKind: null };
      const made = new Span(id, fn, parent, null, Phase.Call, id, 1);
      parent?.addChild(made);
      made.stoppedAt(100 - id);
      return made;
    };
    const test = span(1, "tests", "test_profile", null, Role.Test);
    const route = span(2, "routes", "get_profile", test);
    const service = span(3, "services", "load_profile", route);
    const policy = span(4, "services", "check_access", service);
    const find = span(5, "repositories", "find_user", policy);
    const normalize = span(6, "repositories", "normalize", find);
    const select: BoundaryCall = { system: "postgres", operation: "query", statement: "SELECT * FROM users", startUs: 5, caller: find, phase: Phase.Call };
    find.addBoundaryCall(select);
    const spans = [test, route, service, policy, find, normalize];
    const run = new Run("/app", "2026-11-02", "python", "3.12", "cpython", null, [], [new Scenario("tests/test_profile.py::test_profile", Outcome.Passed, 100, spans, [], [select], [])], []);

    const effects = categorize(run, ZoneRules.none()).items.filter((item) => item.kind === Kind.Callable).map((item) => `${item.name}: ${item.tags.filter((tag) => tag.lens === "effect").flatMap((tag) => tag.evidence).join("; ")}`);

    expect(effects).toMatchInlineSnapshot(`
      [
        "app.repositories.find_user: postgres: SELECT ×1 itself",
        "app.repositories.normalize: no boundary call or field write in 1 recorded call; this recording keeps no source, so field writes aren't seen",
        "app.routes.get_profile: postgres: SELECT through app.repositories.find_user",
        "app.services.check_access: postgres: SELECT through app.repositories.find_user",
        "app.services.load_profile: postgres: SELECT through app.repositories.find_user",
      ]
    `);
  });

  test("a finding the base already had under an old name isn't new: renames are recognised, so a rename doesn't read as fresh drift", async () => {
    const run = await fixtureRuns("go-shop").latest();
    const rules = ZoneRules.parse(JSON.stringify({ ...GO_SHOP_RULES, taxonomy: { rules: [{ id: "cqrs-no-mixed-callable", match: "example\\.com.shop.**" }] } }));
    const [place] = checkTagRules(categorize(run, rules), rules.taxonomy);
    // As the base had it: the same finding on the function before it was renamed.
    const before = { ...place!, item: "example\\.com.shop.internal.orders.Service.PlaceOrder", key: "old-key" };
    const renaming = { module: (name: QualifiedName) => name, type: (name: QualifiedName) => name, functionKey: (key: string) => (key === "old-key" ? place!.key! : key) };

    expect({
      withTheRename: newFindings([before], [place!], renaming).length,
      withoutIt: newFindings([before], [place!], { ...renaming, functionKey: (key: string) => key }).map((finding) => finding.item),
    }).toEqual({ withTheRename: 0, withoutIt: ["example\\.com.shop.internal.orders.Service.Place"] });
  });

  test("fastapi: repositories forced into the core are flagged by role and by I/O; the routed function is a primary adapter", async () => {
    const run = await fixtureRuns("fastapi-slug-refactor").latest();
    const rules = ZoneRules.parse(
      JSON.stringify({
        version: 2,
        style: "hexagonal",
        zones: [
          { match: "app.api.**", zone: "inbound-adapter", reason: "routes", by: "user" },
          { match: "app.**", zone: "core", reason: "everything else, on purpose: the repositories too", by: "user" },
        ],
      }),
    );

    const categorization = categorize(run, rules);

    expect(lines(categorization, (item) => item.name.startsWith("app.services.articles") || item.name.startsWith("app.db.repositories.users") || item.name.endsWith("create_new_article"))).toMatchInlineSnapshot(`
      [
        "container/module app.services.articles [|hexagonal|core]",
        "type/class app.db.repositories.users.UsersRepository [|hexagonal|core]
          ports-and-adapters=secondary-adapter (detected 0.9: calls postgres: INSERT, postgres: SELECT itself; handed to ProfilesRepository as _users_repo)
          tactical-ddd=repository (detected 0.6: its name matches *Repository)",
        "callable/function app.api.routes.articles.articles_resource.create_new_article [|hexagonal|inbound-adapter]
          ports-and-adapters=primary-adapter (detected 0.85: the framework routes POST /api/articles to it)
          effect=reads-state (detected 0.95: postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_favorites_count_for_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_tags_for_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.is_article_favorited_by_user; and 2 more)
          effect=writes-state (detected 0.95: postgres: WITH through app.db.repositories.articles.ArticlesRepository.create_article)
          cqs=both (detected 0.7: returns a value (line 85); postgres: WITH through app.db.repositories.articles.ArticlesRepository.create_article)
          failure=can-fail (detected 0.85: raise at line 72, ran in the tests)",
        "callable/method app.db.repositories.users.UsersRepository.create_user [|hexagonal|core]
          effect=writes-state (detected 0.95: postgres: INSERT ×9 itself; writes a field through app.models.domain.users.UserInDB.change_password)
          io=direct-io (detected 0.95: postgres: INSERT)
          cqs=both (detected 0.7: returns a value (line 48); postgres: INSERT ×9 itself)",
        "callable/method app.db.repositories.users.UsersRepository.get_user_by_email [|hexagonal|core]
          effect=reads-state (detected 0.95: postgres: SELECT ×2 itself)
          io=direct-io (detected 0.95: postgres: SELECT)
          cqs=query (detected 0.7: returns a value (line 13); no recorded write)
          failure=can-fail (detected 0.85: raise at line 15, ran in the tests)",
        "callable/method app.db.repositories.users.UsersRepository.get_user_by_username [|hexagonal|core]
          effect=reads-state (detected 0.95: postgres: SELECT ×33 itself)
          io=direct-io (detected 0.95: postgres: SELECT)
          cqs=query (detected 0.7: returns a value (line 23); no recorded write)
          failure=can-fail (detected 0.85: raise at line 25, ran in the tests)",
        "callable/function app.services.articles._normalize_title [|hexagonal|core]
          effect=pure (detected 0.4: no boundary call or field write in 2 recorded calls)
          cqs=query (detected 0.7: returns a value (line 38); no recorded write)",
        "callable/function app.services.articles.check_article_exists [|hexagonal|core]
          effect=reads-state (detected 0.95: postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_favorites_count_for_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_tags_for_article_by_slug; postgres: SELECT through app.db.repositories.users.UsersRepository.get_user_by_username)
          cqs=query (detected 0.7: returns a value (line 17); no recorded write)",
        "callable/function app.services.articles.ensure_slug_available [|hexagonal|core]
          effect=reads-state (detected 0.95: postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_favorites_count_for_article_by_slug; postgres: SELECT through app.db.repositories.articles.ArticlesRepository.get_tags_for_article_by_slug; postgres: SELECT through app.db.repositories.users.UsersRepository.get_user_by_username)
          cqs=query (detected 0.7: returns a value (line 26); no recorded write)
          failure=can-fail (detected 0.85: raise at line 25, ran in the tests)",
        "callable/function app.services.articles.get_slug_for_article [|hexagonal|core]
          effect=pure (detected 0.4: no boundary call or field write in 2 recorded calls)
          cqs=query (detected 0.7: returns a value (line 34); no recorded write)",
      ]
    `);
    expect(findingLines(checkTagRules(categorization, rules.taxonomy).filter((finding) => finding.item.startsWith("app.db.repositories.users")))).toMatchInlineSnapshot(`
      [
        "warn role-outside-expected-zone: app.db.repositories.users.UsersRepository (core): its role belongs in another zone
          secondary-adapter belongs in outbound-adapter, it's in core (calls postgres: INSERT, postgres: SELECT itself)",
        "warn io-outside-allowed-zones: app.db.repositories.users.UsersRepository.create_user (core): does I/O itself in a zone its style keeps free of it
          direct-io: postgres: INSERT
          hexagonal lets only outbound-adapter talk to external systems; it's in core",
        "warn io-outside-allowed-zones: app.db.repositories.users.UsersRepository.get_user_by_email (core): does I/O itself in a zone its style keeps free of it
          direct-io: postgres: SELECT
          hexagonal lets only outbound-adapter talk to external systems; it's in core",
        "warn io-outside-allowed-zones: app.db.repositories.users.UsersRepository.get_user_by_username (core): does I/O itself in a zone its style keeps free of it
          direct-io: postgres: SELECT
          hexagonal lets only outbound-adapter talk to external systems; it's in core",
      ]
    `);
  });

  test("django in MVC: routed views are controllers even though they query the ORM; serializers are mappers; no source, no CQS", async () => {
    const run = await fixtureRuns("django").latest();
    const rules = ZoneRules.parse(
      JSON.stringify({
        version: 2,
        style: "mvc",
        zones: [
          { match: "conduit.apps.*.views.**", zone: "controller", reason: "DRF views", by: "user" },
          { match: "conduit.apps.*.renderers.**", zone: "view", reason: "render JSON", by: "user" },
          { match: "conduit.**", zone: "model", reason: "models, serializers", by: "user" },
        ],
      }),
    );

    const categorization = categorize(run, rules);

    expect(lines(categorization, (item) => /ArticleViewSet$|ArticleViewSet\.list$|ArticleSerializer$|ArticleJSONRenderer$/.test(item.name))).toMatchInlineSnapshot(`
      [
        "type/class conduit.apps.articles.renderers.ArticleJSONRenderer [|mvc|view]
          mvc-family=view (detected 0.9: placed in view by rule conduit.apps.*.renderers.** (user))",
        "type/class conduit.apps.articles.serializers.ArticleSerializer [|mvc|model]
          boundary=mapper (detected 0.6: its name matches *Serializer)",
        "type/class conduit.apps.articles.views.ArticleViewSet [|mvc|controller]
          mvc-family=controller (detected 0.95: placed in controller by rule conduit.apps.*.views.** (user); the framework routes GET,POST /api/^^articles, GET,POST /api/^^articles\\.(?P<format>[a-z0-9]+)/?, GET,PUT /api/^^articles/(?P<slug>[^/.]+), GET,PUT /api/^^articles/(?P<slug>[^/.]+)\\.(?P<format>[a-z0-9]+)/? to it; its name matches *ViewSet)",
        "callable/method conduit.apps.articles.views.ArticleViewSet.list [|mvc|controller]
          effect=reads-state (detected 0.95: sqlite: SELECT ×3 itself; sqlite: SELECT through conduit.apps.articles.serializers.ArticleSerializer.get_favorites_count)
          io=direct-io (detected 0.95: sqlite: SELECT)",
      ]
    `);
    expect(findingLines(checkTagRules(categorization, rules.taxonomy)).slice(0, 2)).toMatchInlineSnapshot(`
      [
        "warn io-outside-allowed-zones: conduit.apps.articles.views.ArticleViewSet.create (controller): does I/O itself in a zone its style keeps free of it
          direct-io: sqlite: SELECT
          mvc lets only model talk to external systems; it's in controller",
        "warn io-outside-allowed-zones: conduit.apps.articles.views.ArticleViewSet.list (controller): does I/O itself in a zone its style keeps free of it
          direct-io: sqlite: SELECT
          mvc lets only model talk to external systems; it's in controller",
      ]
    `);
  });
});
