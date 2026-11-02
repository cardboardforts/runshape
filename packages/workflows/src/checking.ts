// `runshape check`: is this branch ready for a person to review? It records what's missing,
// compares the branch with where it left the base, and turns the review into findings, each
// one blocking or a warning by runshape.json's `check` section (the base's: a branch can't
// loosen its own gate). A check that can't be made blocks: the gate fails closed. A person's
// OK to go past what's left is kept beside the result, naming exactly the findings it covers.
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
  /** Never configurable: a check that couldn't be made blocks. */
  ReviewNotMade = "review-not-made",
  CheckRulesUnreadable = "check-rules-unreadable",
  CheckRulesChanged = "check-rules-changed",
}

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
  // Outside the gate only: an agent checks as it goes. The gate always blocks on it.
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
  /** --gate: the check before a branch goes to human review (uncommitted changes block). */
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
export function checkFindings(bundle: ReviewBundle, rules: CheckRules, { gate }: { gate: boolean }): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const add = (rule: ConfigurableRule, subject: string, message: string, forced?: CheckSeverity.Block) => {
    const severity = forced ?? rules.severities[rule];
    if (severity !== CheckSeverity.Off) findings.push({ rule, severity, subject, message });
  };
  if (bundle.head.dirty) {
    add(CheckRule.Uncommitted, "the working tree", "has uncommitted changes: the check isn't of a commit anyone can review", gate ? CheckSeverity.Block : undefined);
  }
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

/** What `check` needs of the recordings workflow: compare two names, recording what's missing. */
export interface Comparer {
  compare(base: string, head: string, options: { againstTip: boolean }): Promise<{ review: { bundle: ReviewBundle; name: string }; base: { id: string }; head: { id: string } }>;
}

/** A bypass couldn't be recorded: said to the person as it is. */
export class BypassRefused extends Error {}

export class Checking {
  constructor(
    private readonly comparer: Comparer,
    private readonly recordings: KeptRecordings,
    private readonly checks: KeptChecks,
    private readonly repository: Repository,
    private readonly logger: Logger,
    private readonly now: () => Date,
  ) {}

  /** The base when none is named: the branch of merged code. */
  async defaultBase(): Promise<string | null> {
    return this.repository.mergedBranch();
  }

  /**
   * Compares, finds, and keeps the result as last.json. With blocking findings, a bypass for
   * this very commit that names every one of them lets it pass, and says so.
   */
  async check(baseName: string, headName: string, { gate }: { gate: boolean }): Promise<CheckResult> {
    const started = this.now().getTime();
    const log = this.logger.with({ gate });
    let result: CheckResult;
    try {
      const compared = await this.comparer.compare(baseName, headName, { againstTip: false });
      const { bundle, name } = compared.review;
      const [baseText, headText] = await Promise.all([this.recordings.keptRules(compared.base.id), this.recordings.keptRules(compared.head.id)]);
      const base = readCheckRules(baseText);
      const findings = checkFindings(bundle, base.rules, { gate });
      if (base.problems.length > 0) findings.unshift({ rule: CheckRule.CheckRulesUnreadable, severity: CheckSeverity.Block, subject: "runshape.json", message: `the base's check section can't be read, so the defaults were used: ${base.problems.join("; ")}` });
      const head = readCheckRules(headText);
      if (JSON.stringify(head.section) !== JSON.stringify(base.section)) {
        findings.push({ rule: CheckRule.CheckRulesChanged, severity: CheckSeverity.Warn, subject: "runshape.json", message: "this branch changes the check's rules: they apply once it's merged; this check used the base's" });
      }
      result = this.result(gate, { asked: baseName, commit: bundle.base.commit }, { asked: headName, commit: bundle.head.commit, dirty: bundle.head.dirty }, name, baseText === null ? "the defaults (the base has no runshape.json)" : `the base's runshape.json (${bundle.base.commit.slice(0, 12)})`, findings);
    } catch (error) {
      // Whatever stopped the comparison, the gate fails closed on it, and the log has the stack.
      const reason = error instanceof Error ? error.message : String(error);
      log.log("error", "check.review_not_made", { error: reason, stack: error instanceof Error ? (error.stack ?? null) : null });
      const headCommit = await this.repository.resolve(headName === WORKING_TREE_ID ? "HEAD" : headName).then((summary) => summary.commit, () => null);
      const finding: CheckFinding = { rule: CheckRule.ReviewNotMade, severity: CheckSeverity.Block, subject: `${baseName} .. ${headName}`, message: reason };
      result = this.result(gate, { asked: baseName, commit: null }, { asked: headName, commit: headCommit, dirty: false }, null, "none: there was no review to check", [finding]);
    }
    if (!result.passed) result = await this.withBypass(result);
    await this.checks.saveLast(result);
    const blocking = result.findings.filter((f) => f.severity === CheckSeverity.Block);
    // Rules and subjects, not messages: enough to grep for, and to know what a bypass went past.
    log.log(result.passed && result.bypassed === null ? "info" : "warn", result.bypassed === null ? "check.done" : "check.bypassed", {
      head: result.head.commit,
      review: result.review,
      passed: result.passed,
      blocking: blocking.length,
      warnings: result.findings.length - blocking.length,
      findings: blocking.map((f) => `${f.rule}: ${f.subject}`).join("; "),
      duration_ms: this.now().getTime() - started,
    });
    return result;
  }

  /**
   * Records the person's OK to go past the last check's blocking findings, for that commit
   * only. Refused unless the last check is of the commit checked out, with nothing
   * uncommitted, and something blocked.
   */
  async bypass(ok: string): Promise<CheckBypass> {
    const last = asCheckResult(await this.checks.last());
    if (last === null) throw new BypassRefused("there's no check to go past: run `check` first, and tell the person what it found");
    const working = await this.repository.workingTree();
    if (last.head.commit !== working.commit || working.dirty || last.head.dirty) {
      throw new BypassRefused(`the last check (${last.head.commit?.slice(0, 12) ?? "no commit"}) isn't of what's checked out (${working.commit.slice(0, 12)}${working.dirty ? ", with uncommitted changes" : ""}): commit, run \`check\` again, and tell the person what it found`);
    }
    const blocking = last.findings.filter((f) => f.severity === CheckSeverity.Block);
    if (blocking.length === 0) throw new BypassRefused("the last check found nothing blocking: there's nothing to go past");
    if (ok.trim() === "") throw new BypassRefused("whose OK, and what did they say? check --bypass -- <their words>");
    const bypass: CheckBypass = { format: BYPASS_FORMAT, version: 1, head: working.commit, findings: blocking, ok: ok.trim(), at: this.now().toISOString() };
    await this.checks.saveBypass(bypass);
    this.logger.log("warn", "check.bypass_recorded", { head: working.commit, findings: blocking.map((f) => `${f.rule}: ${f.subject}`).join("; ") });
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

  private result(gate: boolean, base: CheckResult["base"], head: CheckResult["head"], review: string | null, rulesFrom: string, findings: CheckFinding[]): CheckResult {
    const blocking = findings.filter((f) => f.severity === CheckSeverity.Block).length;
    return { format: CHECK_FORMAT, version: 1, checkedAt: this.now().toISOString(), gate, base, head, review, rulesFrom, findings, blocking, bypassed: null, passed: blocking === 0 };
  }

  /** Passes when the kept OK is for this commit and names every blocking finding left. */
  private async withBypass(result: CheckResult): Promise<CheckResult> {
    let saved: unknown;
    try {
      saved = await this.checks.bypass();
    } catch (error) {
      // An OK that can't be read is no OK: the check still fails.
      this.logger.log("warn", "check.bypass_unreadable", { error: error instanceof Error ? error.message : String(error) });
      return result;
    }
    const bypass = asBypass(saved);
    if (bypass === null || result.head.commit === null || bypass.head !== result.head.commit || result.head.dirty) return result;
    const covered = new Set(bypass.findings.map(identity));
    const blocking = result.findings.filter((f) => f.severity === CheckSeverity.Block);
    if (!blocking.every((f) => covered.has(identity(f)))) return result;
    return { ...result, bypassed: bypass, passed: true };
  }
}

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
  const side = (s: { asked: string; commit: string | null }) => (s.asked === WORKING_TREE_ID ? `the working tree (${s.commit?.slice(0, 7) ?? "?"})` : `${s.asked} (${s.commit?.slice(0, 7) ?? "?"})`);
  const warnings = result.findings.length - result.blocking;
  const lines = [`check${result.gate ? " --gate" : ""}: ${side(result.base)} .. ${side(result.head)}: ${result.blocking} blocking, ${warnings} warning${warnings === 1 ? "" : "s"}`];
  for (const f of result.findings) lines.push(`  ${f.severity === CheckSeverity.Block ? "BLOCK" : "warn "} ${f.rule}: ${f.subject}: ${f.message}`);
  lines.push(`rules: ${result.rulesFrom}`, `result: ${shownAt}${result.review === null ? "" : `; review: .runshape/reviews/${result.review}`}`);
  if (result.bypassed !== null) {
    lines.push(`PASSED WITH A BYPASS: ${result.blocking} blocking finding${result.blocking === 1 ? "" : "s"} gone past with the OK given ${result.bypassed.at}: "${result.bypassed.ok}"`);
    lines.push(`For the PR body: Runshape check bypassed on ${result.head.commit?.slice(0, 12)} (${result.findings.filter((f) => f.severity === CheckSeverity.Block).map((f) => `${f.rule}: ${f.subject}`).join("; ")}). OK: "${result.bypassed.ok}"`);
  } else if (result.passed) {
    lines.push("Ready for review: nothing blocks.");
  } else {
    lines.push(
      "Not ready for review. Fix what blocks, or tell the person exactly these findings;",
      "only with their OK: runshape check --bypass -- <who said it's fine, in their words>",
    );
  }
  return lines;
}

const FAILING = new Set<string>([Outcome.Failed, Outcome.Error, Outcome.UnexpectedPass]);

function identity(finding: CheckFinding): string {
  return `${finding.rule}\n${finding.subject}`;
}

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
