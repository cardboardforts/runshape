// `runshape check`: is this branch ready for a person to review? It records what's missing,
// compares the branch with where it left the base, and turns the review into findings, each
// one blocking or a warning by runshape.json's `check` section (the base's: a branch can't
// loosen its own gate, and one that tries is blocked). A check that can't be made blocks: the
// gate fails closed. A person's OK to go past what's left names exactly the commit and the
// findings it covers.
import { KeptChecks, KeptRecordings, Logger, Outcome, PushGate, Repository, ReviewCategory, WORKING_TREE_ID } from "@runshape/kernel";
import { TIME_NOISE_FLOOR_US, TIME_NOISE_RATIO, TimeVerdict, WorkflowSides } from "@runshape/trace";

import { ReviewBundle } from "./review-bundle";

export enum CheckSeverity {
  /** Fails the check: the branch isn't offered for human review until it's fixed or a person OKs it. */
  Block = "block",
  Warn = "warn",
  Off = "off",
}

export enum CheckRule {
  NowFailing = "now-failing",
  NewViolations = "new-violations",
  CategorizerErrors = "categorizer-errors",
  CategorizerWarnings = "categorizer-warnings",
  LlmPlacements = "llm-placements",
  MoreExternalCalls = "more-external-calls",
  Slower = "slower",
  Uncommitted = "uncommitted",
  /** Never configurable, and never bypassed: a check that couldn't be made blocks. */
  ReviewNotMade = "review-not-made",
  /** Never bypassed: the review isn't of the commit the gate was asked about. */
  HeadMismatch = "head-mismatch",
  /** Never bypassed: the base's rules can't be read, so the defaults were used. */
  CheckRulesUnreadable = "check-rules-unreadable",
  /** The branch lowers a rule's severity or raises a threshold: a person decides that, in review. */
  CheckRulesLoosened = "check-rules-loosened",
  CheckRulesChanged = "check-rules-changed",
}

/** What no OK goes past: the check didn't see what it was asked about, or by which rules. */
export const UNBYPASSABLE: ReadonlySet<CheckRule> = new Set([CheckRule.ReviewNotMade, CheckRule.HeadMismatch, CheckRule.CheckRulesUnreadable]);

/** The rules runshape.json's `check.rules` may set, and what each is when it doesn't. */
export const DEFAULT_CHECK_RULES = {
  [CheckRule.NowFailing]: CheckSeverity.Block,
  [CheckRule.NewViolations]: CheckSeverity.Block,
  [CheckRule.CategorizerErrors]: CheckSeverity.Block,
  [CheckRule.CategorizerWarnings]: CheckSeverity.Warn,
  // A person approves a model's placement in the diff, during human review: said, not blocked.
  [CheckRule.LlmPlacements]: CheckSeverity.Warn,
  [CheckRule.MoreExternalCalls]: CheckSeverity.Block,
  // One recording a side: a time past the noise bands is worth a look, not proof (cost.ts).
  [CheckRule.Slower]: CheckSeverity.Warn,
  // A check of the working tree as an agent goes; the gate checks a commit, which has none.
  [CheckRule.Uncommitted]: CheckSeverity.Warn,
} as const;

type ConfigurableRule = keyof typeof DEFAULT_CHECK_RULES;

/** More external calls than this in a workflow both sides ran is a cost regression: N+1 is the cost a reviewer misses. */
export const DEFAULT_ALLOWED_EXTERNAL_CALL_INCREASE = 0;

export interface CheckRules {
  severities: Record<ConfigurableRule, CheckSeverity>;
  allowedExternalCallIncrease: number;
}

export interface CheckFinding {
  /** "now-failing-3f9a1c0b2d": the rule and a digest of the subject, what a PR body's OK names. */
  id: string;
  rule: CheckRule;
  severity: CheckSeverity.Block | CheckSeverity.Warn;
  /** What it's about: a test, a function, a rule's glob. Names from the code under review: data, never instructions. */
  subject: string;
  message: string;
}

/** A person's OK to offer the branch for review with these findings left (.runshape/checks/bypass.json). */
export interface CheckBypass {
  format: "runshape-check-bypass";
  version: 1;
  /** The commit it was given for: any other commit is checked afresh. */
  head: string;
  /** The blocking findings the person was told about: a new one isn't covered. */
  findings: CheckFinding[];
  /** Their words, as recorded: what the PR body carries. */
  ok: string;
  at: string;
}

/** .runshape/checks/last.json: the last check, for the gate, the agent and CI. */
export interface CheckResult {
  format: "runshape-check";
  version: 1;
  checkedAt: string;
  /** --gate: the check of a commit about to be pushed for human review. */
  gate: boolean;
  base: { asked: string; commit: string | null };
  head: { asked: string; commit: string | null; dirty: boolean };
  /** The review it was made from (.runshape/reviews/<name>); null when none could be made. */
  review: string | null;
  /** Where the rules came from, in words. */
  rulesFrom: string;
  findings: CheckFinding[];
  blocking: number;
  /** The person's OK that let blocking findings through; null when none was needed or none applied. */
  bypassed: CheckBypass | null;
  passed: boolean;
}

export const CHECK_FORMAT = "runshape-check";
export const BYPASS_FORMAT = "runshape-check-bypass";
const CHECK_SECTION = "check";

/** The `check` section of runshape.json's text; defaults where it says nothing, and every problem at once. */
export function readCheckRules(text: string | null): { rules: CheckRules; problems: string[]; section: unknown } {
  const rules: CheckRules = { severities: { ...DEFAULT_CHECK_RULES }, allowedExternalCallIncrease: DEFAULT_ALLOWED_EXTERNAL_CALL_INCREASE };
  if (text === null) return { rules, problems: [], section: null };
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { rules, problems: [`runshape.json isn't JSON: ${error instanceof Error ? error.message : String(error)}`], section: null };
  }
  const section = isObject(data) ? data[CHECK_SECTION] : undefined;
  if (section === undefined) return { rules, problems: [], section: null };
  const problems: string[] = [];
  if (!isObject(section)) return { rules, problems: ["check must be an object: { \"rules\": { ... }, \"allowedExternalCallIncrease\": 0 }"], section };
  for (const key of Object.keys(section)) {
    // A misspelt key that silently did nothing would loosen nobody knows what.
    if (key !== "rules" && key !== "allowedExternalCallIncrease") problems.push(`check.${key} isn't a setting: rules, allowedExternalCallIncrease`);
  }
  const given = section.rules;
  if (given !== undefined && !isObject(given)) problems.push("check.rules must be an object of rule: block|warn|off");
  if (isObject(given)) {
    for (const [rule, severity] of Object.entries(given)) {
      if (!(rule in DEFAULT_CHECK_RULES)) problems.push(`check.rules.${rule} isn't a rule: ${Object.keys(DEFAULT_CHECK_RULES).join(", ")}`);
      else if (severity !== CheckSeverity.Block && severity !== CheckSeverity.Warn && severity !== CheckSeverity.Off) problems.push(`check.rules.${rule} is ${JSON.stringify(severity)}: block, warn or off`);
      else rules.severities[rule as ConfigurableRule] = severity;
    }
  }
  const allowed = section.allowedExternalCallIncrease;
  if (allowed !== undefined) {
    if (typeof allowed !== "number" || !Number.isInteger(allowed) || allowed < 0) problems.push("check.allowedExternalCallIncrease must be a whole number, 0 or more");
    else rules.allowedExternalCallIncrease = allowed;
  }
  // Rules that couldn't be read are the defaults, whole: half a section isn't what anyone wrote.
  if (problems.length > 0) return { rules: { severities: { ...DEFAULT_CHECK_RULES }, allowedExternalCallIncrease: DEFAULT_ALLOWED_EXTERNAL_CALL_INCREASE }, problems, section };
  return { rules, problems, section };
}

/** What in a review should stop a branch going to human review, or be said when it does. */
export function checkFindings(bundle: ReviewBundle, rules: CheckRules): Found[] {
  const findings: Found[] = [];
  const add = (rule: ConfigurableRule, subject: string, message: string) => {
    const severity = rules.severities[rule];
    if (severity !== CheckSeverity.Off) findings.push({ rule, severity, subject, message });
  };
  if (bundle.head.dirty) add(CheckRule.Uncommitted, "the working tree", "has uncommitted changes: the check isn't of a commit anyone can review");
  for (const item of bundle.review.items) {
    const newAndFailing = item.category === ReviewCategory.Added && item.outcomeAfter !== null && FAILING.has(item.outcomeAfter);
    if (item.category === ReviewCategory.NowFailing || newAndFailing) add(CheckRule.NowFailing, item.name, `${item.outcomeBefore ?? "new"} before, ${item.outcomeAfter} now`);
  }
  for (const v of bundle.violations ?? []) add(CheckRule.NewViolations, `${v.from} → ${v.to}`, `${v.violation} (${v.fromZone} → ${v.toZone}, ${v.calls} call${v.calls === 1 ? "" : "s"})`);
  for (const finding of bundle.categories?.newFindings ?? []) {
    const rule = finding.severity === "error" ? CheckRule.CategorizerErrors : finding.severity === "warn" ? CheckRule.CategorizerWarnings : null;
    if (rule !== null) add(rule, finding.item, `${finding.rule}: ${finding.message}`);
  }
  const { rules: zoneRules, regions } = bundle.architecture;
  for (const rule of [...zoneRules.added, ...zoneRules.changed.map((change) => change.after)]) {
    if (rule.by === "llm") add(CheckRule.LlmPlacements, rule.match, `placed in ${rule.zone} by a model ("by": "llm") in this branch: awaiting your approval in the diff`);
  }
  for (const region of [...regions.added, ...regions.changed.map((change) => change.after)]) {
    if (region.by === "llm") add(CheckRule.LlmPlacements, region.path, `a region (${region.style}) a model drew ("by": "llm") in this branch: awaiting your approval in the diff`);
  }
  for (const workflow of bundle.cost?.workflows ?? []) {
    if (workflow.sides !== WorkflowSides.Both) continue;
    const { before, after } = workflow.externalCalls;
    if (before !== null && after !== null && after - before > rules.allowedExternalCallIncrease) {
      add(CheckRule.MoreExternalCalls, workflow.name, `${before} → ${after} external calls (more than ${rules.allowedExternalCallIncrease} more)`);
    }
    if (workflow.time === TimeVerdict.Slower) {
      const ms = (us: number | null) => (us === null ? "?" : `${Math.round(us / 100) / 10} ms`);
      add(CheckRule.Slower, workflow.name, `${ms(workflow.timeUs.before)} → ${ms(workflow.timeUs.after)} (past both ${TIME_NOISE_FLOOR_US / 1000} ms and ${Math.round(TIME_NOISE_RATIO * 100)}%; one recording a side)`);
    }
  }
  return findings;
}

/** A finding before it has its id. */
export type Found = Omit<CheckFinding, "id">;

const SEVERITY_RANK: Record<CheckSeverity, number> = { [CheckSeverity.Off]: 0, [CheckSeverity.Warn]: 1, [CheckSeverity.Block]: 2 };

/** Where head's rules are looser than the base's: a severity lowered (a rule removed falls to its default), a threshold raised. */
export function loosenedRules(base: CheckRules, head: CheckRules): Found[] {
  const found: Found[] = [];
  for (const rule of Object.keys(DEFAULT_CHECK_RULES) as ConfigurableRule[]) {
    const [before, after] = [base.severities[rule], head.severities[rule]];
    if (SEVERITY_RANK[after] < SEVERITY_RANK[before]) found.push({ rule: CheckRule.CheckRulesLoosened, severity: CheckSeverity.Block, subject: `check.rules.${rule}`, message: `${before} on the base, ${after} in this branch: loosening the gate is for a person to approve` });
  }
  if (head.allowedExternalCallIncrease > base.allowedExternalCallIncrease) {
    found.push({ rule: CheckRule.CheckRulesLoosened, severity: CheckSeverity.Block, subject: "check.allowedExternalCallIncrease", message: `${base.allowedExternalCallIncrease} on the base, ${head.allowedExternalCallIncrease} in this branch: loosening the gate is for a person to approve` });
  }
  return found;
}

/** A PR body's OK, as the person wrote it: "Runshape bypass: <commit> <finding id>...". */
const PR_BODY_BYPASS = /^Runshape bypass: ([0-9a-f]{40}|[0-9a-f]{64})((?: [a-z-]+-[0-9a-f]+)+)\s*$/gm;

/** The finding ids a PR body OKs for this commit; none when it says nothing about it. */
export function prBodyBypass(body: string, head: string): Set<string> {
  const ids = new Set<string>();
  for (const match of body.matchAll(PR_BODY_BYPASS)) {
    if (match[1] === head) for (const id of match[2]!.trim().split(" ")) ids.add(id);
  }
  return ids;
}

/** What `check` needs of the recordings workflow: compare two names, recording what's missing. */
export interface Comparer {
  compare(base: string, head: string, options: { againstTip: boolean }): Promise<{ review: { bundle: ReviewBundle; name: string }; base: { id: string }; head: { id: string } }>;
}

/** A bypass couldn't be recorded: said to the person as it is. */
export class BypassRefused extends Error {}

export interface CheckOptions {
  gate: boolean;
  /** The commit the gate was asked about (the one being pushed): the review must be of it. */
  expectedHead?: string;
  /** A PR's body, read for "Runshape bypass:" lines instead of the OK kept here (CI). */
  prBody?: string;
}

export class Checking {
  constructor(
    private readonly comparer: Comparer,
    private readonly recordings: KeptRecordings,
    private readonly checks: KeptChecks,
    private readonly repository: Repository,
    private readonly logger: Logger,
    private readonly now: () => Date,
    /** Hashing's sha256: each finding's id. */
    private readonly digest: (text: string) => string,
  ) {}

  /** The base when none is named: the branch of merged code. */
  async defaultBase(): Promise<string | null> {
    return this.repository.mergedBranch();
  }

  /** The commit a name resolves to, for --gate's head. */
  async commitOf(name: string): Promise<string> {
    return (await this.repository.resolve(name)).commit;
  }

  /**
   * Compares, finds, and keeps the result as last.json. With blocking findings, an OK for this
   * very commit that names every one of them lets it pass, and says so.
   */
  async check(baseName: string, headName: string, options: CheckOptions): Promise<CheckResult> {
    const { gate } = options;
    const started = this.now().getTime();
    const log = this.logger.with({ gate });
    let result: CheckResult;
    try {
      const compared = await this.comparer.compare(baseName, headName, { againstTip: false });
      const { bundle, name } = compared.review;
      const [baseText, headText] = await Promise.all([this.recordings.keptRules(compared.base.id), this.recordings.keptRules(compared.head.id)]);
      const base = readCheckRules(baseText);
      const head = readCheckRules(headText);
      const found: Found[] = [];
      if (options.expectedHead !== undefined && bundle.head.commit !== options.expectedHead) {
        found.push({ rule: CheckRule.HeadMismatch, severity: CheckSeverity.Block, subject: options.expectedHead, message: `the review is of ${bundle.head.commit}, not the commit asked about` });
      }
      if (base.problems.length > 0) found.push({ rule: CheckRule.CheckRulesUnreadable, severity: CheckSeverity.Block, subject: "runshape.json", message: `the base's check section can't be read, so the defaults were used: ${base.problems.join("; ")}` });
      const loosened = loosenedRules(base.rules, head.rules);
      found.push(...loosened, ...checkFindings(bundle, base.rules));
      if (loosened.length === 0 && JSON.stringify(head.section) !== JSON.stringify(base.section)) {
        found.push({ rule: CheckRule.CheckRulesChanged, severity: CheckSeverity.Warn, subject: "runshape.json", message: "this branch changes the check's rules: they apply once it's merged; this check used the base's" });
      }
      result = this.result(gate, { asked: baseName, commit: bundle.base.commit }, { asked: headName, commit: bundle.head.commit, dirty: bundle.head.dirty }, name, baseText === null ? "the defaults (the base has no runshape.json)" : `the base's runshape.json (${bundle.base.commit.slice(0, 12)})`, found);
    } catch (error) {
      // Whatever stopped the comparison, the gate fails closed on it, and the log has the stack.
      const reason = error instanceof Error ? error.message : String(error);
      log.log("error", "check.review_not_made", { error: reason, stack: error instanceof Error ? (error.stack ?? null) : null });
      const headCommit = options.expectedHead ?? (await this.repository.resolve(headName === WORKING_TREE_ID ? "HEAD" : headName).then((summary) => summary.commit, () => null));
      const finding: Found = { rule: CheckRule.ReviewNotMade, severity: CheckSeverity.Block, subject: `${baseName} .. ${headName}`, message: reason };
      result = this.result(gate, { asked: baseName, commit: null }, { asked: headName, commit: headCommit, dirty: false }, null, "none: there was no review to check", [finding]);
    }
    if (!result.passed) result = await this.withBypass(result, options.prBody);
    await this.checks.saveLast(result);
    const blocking = result.findings.filter((f) => f.severity === CheckSeverity.Block);
    // Ids, rules and subjects, not messages: enough to grep for, and to know what a bypass went past.
    log.log(result.passed && result.bypassed === null ? "info" : "warn", result.bypassed === null ? "check.done" : "check.bypassed", {
      head: result.head.commit,
      review: result.review,
      passed: result.passed,
      blocking: blocking.length,
      warnings: result.findings.length - blocking.length,
      findings: blocking.map((f) => `${f.id} ${f.subject}`).join("; "),
      ...(result.bypassed === null ? {} : { ok: result.bypassed.ok }),
      duration_ms: this.now().getTime() - started,
    });
    return result;
  }

  /**
   * The last check's blocking findings, if a person may OK them: the check is of a commit
   * (not uncommitted changes), something blocked, and nothing that blocked is unbypassable.
   */
  async bypassable(): Promise<{ head: string; findings: CheckFinding[] }> {
    const last = asCheckResult(await this.checks.last());
    if (last === null) throw new BypassRefused("there's no check to go past: run `check` first, and tell the person what it found");
    if (last.head.commit === null || last.head.dirty) throw new BypassRefused("the last check isn't of a commit (it had uncommitted changes, or none): commit, run `check` again, and tell the person what it found");
    const blocking = last.findings.filter((f) => f.severity === CheckSeverity.Block);
    if (blocking.length === 0) throw new BypassRefused("the last check found nothing blocking: there's nothing to go past");
    const never = blocking.filter((f) => UNBYPASSABLE.has(f.rule));
    if (never.length > 0) throw new BypassRefused(`no OK goes past ${never.map((f) => f.rule).join(", ")}: the check didn't see what it was asked about. Fix that and check again`);
    return { head: last.head.commit, findings: blocking };
  }

  /**
   * Records the person's OK to go past the last check's blocking findings, for that commit
   * only. The app asks the person (bypassable() says what to show them); this records it.
   */
  async bypass(ok: string): Promise<CheckBypass> {
    const { head, findings } = await this.bypassable();
    if (ok.trim() === "") throw new BypassRefused("whose OK, and what did they say? check --bypass -- <their words>");
    const bypass: CheckBypass = { format: BYPASS_FORMAT, version: 1, head, findings, ok: ok.trim(), at: this.now().toISOString() };
    await this.checks.saveBypass(bypass);
    this.logger.log("warn", "check.bypass_recorded", { head, findings: findings.map((f) => `${f.id} ${f.subject}`).join("; "), ok: bypass.ok });
    return bypass;
  }

  /** Makes `check --gate` run before every push; logged, since it changes what a push does. */
  async installGate(gate: PushGate): Promise<{ where: string; replaced: boolean } | { refused: string }> {
    const installed = await gate.install();
    if ("refused" in installed) this.logger.log("warn", "check.gate_refused", { reason: installed.refused });
    else this.logger.log("info", "check.gate_installed", { where: installed.where, replaced: installed.replaced });
    return installed;
  }

  /** The last check's result; null before the first. */
  async last(): Promise<CheckResult | null> {
    return asCheckResult(await this.checks.last());
  }

  private result(gate: boolean, base: CheckResult["base"], head: CheckResult["head"], review: string | null, rulesFrom: string, found: Found[]): CheckResult {
    // Blockers first: under --gate they're what the person reads.
    const findings = [...found]
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
      .map((f) => ({ id: `${f.rule}-${this.digest(`${f.rule}\n${f.subject}`).slice(0, FINDING_ID_DIGITS)}`, ...f }));
    const blocking = findings.filter((f) => f.severity === CheckSeverity.Block).length;
    return { format: CHECK_FORMAT, version: 1, checkedAt: this.now().toISOString(), gate, base, head, review, rulesFrom, findings, blocking, bypassed: null, passed: blocking === 0 };
  }

  /**
   * Passes when an OK is for this commit and names every blocking finding left: the PR body's
   * when one is given (CI), else the one kept here. Nothing unbypassable is ever gone past.
   */
  private async withBypass(result: CheckResult, prBody: string | undefined): Promise<CheckResult> {
    const blocking = result.findings.filter((f) => f.severity === CheckSeverity.Block);
    if (result.head.commit === null || result.head.dirty || blocking.some((f) => UNBYPASSABLE.has(f.rule))) return result;
    if (prBody !== undefined) {
      const named = prBodyBypass(prBody, result.head.commit);
      if (!blocking.every((f) => named.has(f.id))) return result;
      return { ...result, bypassed: { format: BYPASS_FORMAT, version: 1, head: result.head.commit, findings: blocking, ok: "the PR body's Runshape bypass line", at: this.now().toISOString() }, passed: true };
    }
    let saved: unknown;
    try {
      saved = await this.checks.bypass();
    } catch (error) {
      // An OK that can't be read is no OK: the check still fails.
      this.logger.log("warn", "check.bypass_unreadable", { error: error instanceof Error ? error.message : String(error) });
      return result;
    }
    const bypass = asBypass(saved);
    if (bypass === null || bypass.head !== result.head.commit) return result;
    const covered = new Set(bypass.findings.map((f) => f.id));
    if (!blocking.every((f) => covered.has(f.id))) return result;
    return { ...result, bypassed: bypass, passed: true };
  }
}

/** Hex digits of a finding's id: enough that a crafted name can't collide with an OKed one by chance. */
const FINDING_ID_DIGITS = 16;

/** `check`'s exit code, by the worst finding left. */
export enum CheckExit {
  Clean = 0,
  /** Something blocks review, or the check couldn't be made. */
  Blocked = 1,
  /** Only warnings: worth a look, nothing blocks. Under --gate this is Clean, so a push goes. */
  Warned = 2,
}

export function checkExitCode(result: CheckResult): CheckExit {
  if (!result.passed) return CheckExit.Blocked;
  if (result.gate || result.bypassed !== null || result.findings.length === 0) return CheckExit.Clean;
  return CheckExit.Warned;
}

/** The check's human text: what was compared, each finding, and what to do next. */
export function checkText(result: CheckResult, shownAt: string): string[] {
  const side = (s: { asked: string; commit: string | null }) => {
    const short = s.commit?.slice(0, 7) ?? "?";
    if (s.asked === WORKING_TREE_ID) return `the working tree (${short})`;
    return FULL_COMMIT.test(s.asked) ? s.asked.slice(0, 12) : `${s.asked} (${short})`;
  };
  const warnings = result.findings.length - result.blocking;
  const lines = [`check${result.gate ? " --gate" : ""}: ${side(result.base)} .. ${side(result.head)}: ${result.blocking} blocking, ${warnings} warning${warnings === 1 ? "" : "s"}`];
  // Under --gate, a push's output: the count of warnings, then only what blocks.
  if (result.gate && warnings > 0) lines.push(`  ${warnings} warning${warnings === 1 ? "" : "s"} (\`check\` without --gate lists them; ${shownAt} has them all)`);
  for (const f of result.findings) {
    if (result.gate && f.severity !== CheckSeverity.Block) continue;
    lines.push(`  ${f.severity === CheckSeverity.Block ? "BLOCK" : "warn "} ${f.id}: ${f.subject}: ${f.message}`);
  }
  lines.push(`rules: ${result.rulesFrom}`, `result: ${shownAt}${result.review === null ? "" : `; review: .runshape/reviews/${result.review}`}`);
  if (result.bypassed !== null) {
    lines.push(`PASSED WITH A BYPASS: ${result.blocking} blocking finding${result.blocking === 1 ? "" : "s"} gone past with the OK given ${result.bypassed.at}: "${result.bypassed.ok}"`);
    lines.push(`For the PR body (CI reads this line): Runshape bypass: ${result.head.commit} ${result.findings.filter((f) => f.severity === CheckSeverity.Block).map((f) => f.id).join(" ")}`);
  } else if (result.passed) {
    lines.push("Ready for review: nothing blocks.");
  } else {
    lines.push(
      "Not ready for review. Fix what blocks, or tell the person exactly these findings;",
      "only with their OK, typed by them at a terminal: runshape check --bypass -- <who said it's fine, in their words>",
    );
  }
  return lines;
}

const FULL_COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const FAILING = new Set<string>([Outcome.Failed, Outcome.Error, Outcome.UnexpectedPass]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCheckResult(value: unknown): CheckResult | null {
  if (!isObject(value)) return null;
  if (value.format !== CHECK_FORMAT || value.version !== 1 || !Array.isArray(value.findings)) throw new Error(`the last check isn't a version 1 ${CHECK_FORMAT}: run check again`);
  return value as unknown as CheckResult;
}

/** A kept OK, or null when there's none or it isn't one (an OK that can't be read is no OK). */
function asBypass(value: unknown): CheckBypass | null {
  if (!isObject(value) || value.format !== BYPASS_FORMAT || value.version !== 1 || typeof value.head !== "string" || !Array.isArray(value.findings)) return null;
  return value as unknown as CheckBypass;
}
