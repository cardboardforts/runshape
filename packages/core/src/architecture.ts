// Prototype: which architecture is this app shaped like? The rest of the viewer assumes the
// onion; this module is the first step to drawing each app in its own shape. It scores a
// catalogue of styles against evidence from a recording and proposes how the app's
// modules map onto that style's zones. A person (or a model, see
// .claude/skills/architecture-shape) decides; this only proposes, and says why.
import { QualifiedName, Run } from "@runshape/trace";
import { ArchitectureStyle, HexagonalZone, LayoutShape, PROFILES } from "./profiles";
import { buildSystemGraph } from "./views/system-graph";
import { ZoneRule, ZoneRules } from "./zones";

export interface ZoneProposal {
  zone: string;
  /** Dotted-name globs, in the same form as runshape.json rules. */
  patterns: string[];
}

export interface ArchitectureCandidate {
  style: ArchitectureStyle;
  name: string;
  layout: LayoutShape;
  /** 0–1; relative, for ranking candidates against each other, not a probability. */
  score: number;
  evidence: string[];
  zones: ZoneProposal[];
}

/**
 * Scores every profile on two kinds of evidence from the recording:
 * - vocabulary: how many of the app's packages are named the way the style names its zones;
 * - behaviour: whether what talks to the database, and what receives requests, fits the
 *   style (data mappers suggest layered or hexagonal; models that query for themselves
 *   suggest MVC with active record).
 */
export function detectArchitecture(run: Run): ArchitectureCandidate[] {
  const packages = projectPackages(run);
  const graph = buildSystemGraph(run, { grouping: { collapseMiddleware: true } });
  const talksToStorage = graph.nodes.filter((n) => n.zone === HexagonalZone.OutboundAdapter).map((n) => n.qualifiedName ?? n.label);
  const receivesRequests = graph.nodes.filter((n) => n.zone === HexagonalZone.InboundAdapter).map((n) => n.qualifiedName ?? n.label);
  const activeRecord = talksToStorage.filter((name) => /\.models\./.test(name));
  const dataMappers = talksToStorage.filter((name) => /(repositor|dao|gateway|queries)/i.test(name));
  const zoneOf = new Map(graph.nodes.map((n) => [n.id, n.zone]));
  // Drawn as a hexagon (the default), a handler calling persistence is a forbidden call.
  const handlerToStorage = graph.edges.filter(
    (e) => e.violation !== null && zoneOf.get(e.from) === HexagonalZone.InboundAdapter && zoneOf.get(e.to) === HexagonalZone.OutboundAdapter,
  ).length;

  const candidates = PROFILES.map((profile): ArchitectureCandidate => {
    const evidence: string[] = [];
    const zones: ZoneProposal[] = [];
    let matchedZones = 0;
    for (const zone of profile.zones) {
      const words = profile.vocabulary[zone.id] ?? [];
      const patterns = packages.filter((pkg) => words.includes(pkg.last)).map((pkg) => `${pkg.text}.**`);
      zones.push({ zone: zone.id, patterns });
      if (patterns.length > 0) {
        matchedZones += 1;
        evidence.push(`${zone.name}: ${patterns.map(packageOfPattern).join(", ")}`);
      }
    }
    let score = matchedZones / profile.zones.length;

    if (profile.style === ArchitectureStyle.Mvc && activeRecord.length > 0) {
      score += 0.3;
      evidence.push(`models query the database themselves (active record): ${short(activeRecord)}`);
    }
    if ((profile.style === ArchitectureStyle.Layered || profile.style === ArchitectureStyle.Hexagonal) && dataMappers.length > 0) {
      score += 0.25;
      evidence.push(`persistence sits behind repositories/gateways: ${short(dataMappers)}`);
    }
    if (profile.style === ArchitectureStyle.Hexagonal && !packages.some((pkg) => /\b(ports|adapters|domain)$/.test(pkg.last))) {
      score -= 0.2;
      evidence.push("no ports/adapters/domain package: nothing names the hexagon's boundary");
    }
    // Behaviour separates styles that share vocabulary: request handlers reaching straight
    // into persistence is ordinary in a (relaxed) layered app and a contradiction in a hexagon.
    if (handlerToStorage > 0 && profile.style === ArchitectureStyle.Hexagonal) {
      score -= 0.25;
      evidence.push(`request handlers call persistence directly (${handlerToStorage} call paths), bypassing any core`);
    }
    if (handlerToStorage > 0 && profile.style === ArchitectureStyle.Layered) {
      evidence.push(`request handlers call persistence directly (${handlerToStorage} call paths): a relaxed layering`);
    }
    if ((profile.style === ArchitectureStyle.Mvvm || profile.style === ArchitectureStyle.Mvp) && receivesRequests.length > 0) {
      score -= 0.3;
      evidence.push("a request/response backend: MVVM and MVP are UI patterns");
    }
    return { style: profile.style, name: profile.name, layout: profile.layout, score: clamp(score / 1.3), evidence, zones };
  });
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * The candidate as runshape.json rules. First match wins, so deeper packages go first: a
 * package matching one zone inside a package matching another (app.models.domain inside
 * app.models) keeps its own zone. One inside a package of the same zone is left out.
 */
export function proposedRules(candidate: ArchitectureCandidate): ZoneRules {
  const profile = PROFILES.find((p) => p.style === candidate.style)!;
  const rules: ZoneRule[] = [];
  for (const proposal of candidate.zones) {
    const zoneName = profile.zones.find((zone) => zone.id === proposal.zone)?.name ?? proposal.zone;
    for (const pattern of proposal.patterns) {
      const word = QualifiedName.parse(packageOfPattern(pattern)).last;
      rules.push({ match: pattern, zone: proposal.zone, reason: `${zoneName.toLowerCase()}: the package is named "${word}"`, by: "detected" });
    }
  }
  const packageOf = (rule: ZoneRule) => QualifiedName.parse(packageOfPattern(rule.match));
  const depth = (rule: ZoneRule) => packageOf(rule).segments.length;
  // A rule inside a broader one that already says the same zone adds nothing.
  const needed = rules.filter((rule) => {
    const enclosing = rules
      .filter((other) => other !== rule && packageOf(other).holds(packageOf(rule)))
      .sort((a, b) => depth(b) - depth(a))[0];
    return enclosing === undefined || enclosing.zone !== rule.zone;
  });
  needed.sort((a, b) => depth(b) - depth(a) || a.match.localeCompare(b.match));
  return new ZoneRules(needed, profile);
}

/**
 * Every package and module in the app's own code. Modules count too: Django names its roles
 * per module (app/views.py, app/models.py), other frameworks per package (app/api/routes/).
 */
export function projectPackages(run: Run): QualifiedName[] {
  const testFiles = /(^|\/)tests?\//;
  const packages = new Map<string, QualifiedName>();
  for (const fn of run.catalog) {
    if (testFiles.test(fn.file)) continue;
    const segments = fn.symbol.namespace;
    for (let length = 1; length <= segments.length; length += 1) {
      const pkg = new QualifiedName(segments.slice(0, length));
      packages.set(pkg.key, pkg);
    }
  }
  return [...packages.values()].sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

/** "app.db.**" -> "app.db": the package a proposed rule covers. */
function packageOfPattern(pattern: string): string {
  return pattern.replace(/\.\*\*$/, "");
}

/** Last segments of graph node names (Runshape's dotted text), first three. */
function short(names: string[]): string {
  const labels = [...new Set(names.map((name) => QualifiedName.parse(name).last))];
  return labels.length > 3 ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more` : labels.join(", ");
}

function clamp(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}
