// Asking a language model which architecture an app has, past what package names can tell.
// The deterministic ranking is its evidence; the model may disagree, and must say why. Like
// zone advice it only proposes: the session keeps the proposal and a person adopts it.
import { ArchitectureCandidate } from "./architecture";
import type { QualifiedName } from "./model";
import { Confidence, languageName } from "./zone-advice";
import { PROFILES, profileFor } from "./profiles";
import { ZoneRule, ZoneRules } from "./zones";

export interface ArchitectureAdvice {
  rules: ZoneRules;
  reason: string;
  confidence: Confidence;
}

export class ArchitectureAdviceError extends Error {}

const MAX_PACKAGES = 150;

export function architecturePrompt(candidates: ArchitectureCandidate[], packages: QualifiedName[], language: string): string {
  const styles = PROFILES.map(
    (profile) => `- ${profile.style} (${profile.name}): zones ${profile.zones.map((zone) => `${zone.id} = ${zone.meaning}`).join("; ")}`,
  ).join("\n");
  const ranking = candidates
    .map((candidate) => `- ${candidate.style} scored ${candidate.score}:\n${candidate.evidence.map((line) => `    - ${line}`).join("\n")}`)
    .join("\n");
  const shown = packages.slice(0, MAX_PACKAGES);
  return `You are deciding which architecture style a ${languageName(language)} application follows, so a viewer can draw it.
Styles and their zones:
${styles}

A heuristic ranked them from package names and from what the recorded tests did at runtime:
${ranking}

The application's packages and modules${packages.length > shown.length ? ` (first ${shown.length} of ${packages.length})` : ""}:
${shown.map((name) => `  ${name.text}`).join("\n")}

Pick the style the code most plausibly follows (it may differ from the heuristic's first choice;
names can mislead, e.g. a package called "models" holding domain objects). Then map packages to
that style's zones with dotted-name globs ("app.api.**" matches app.api and everything under it).
List more specific globs before broader ones: the first match wins.

Answer with only a JSON object, no prose around it:
{"style": ${PROFILES.map((profile) => JSON.stringify(profile.style)).join(" | ")}, "reason": "<two or three sentences>", "confidence": "low" | "medium" | "high", "zones": [{"match": "<glob>", "zone": "<a zone id of that style>"}]}`;
}

/** Validates the whole answer and reports every problem at once. */
export function parseArchitectureAdvice(text: string): ArchitectureAdvice {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ArchitectureAdviceError("the model did not answer with a JSON object");
  let data: { style?: unknown; reason?: unknown; confidence?: unknown; zones?: unknown };
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ArchitectureAdviceError("the model's answer was not valid JSON");
  }
  const problems: string[] = [];
  const profile = typeof data.style === "string" ? profileFor(data.style) : undefined;
  if (profile === undefined) problems.push(`unknown style ${JSON.stringify(data.style)}`);
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  if (reason === "") problems.push("no reason given");
  const rules: ZoneRule[] = [];
  if (!Array.isArray(data.zones)) problems.push(`"zones" is not a list`);
  (Array.isArray(data.zones) ? data.zones : []).forEach((entry: { match?: unknown; zone?: unknown }, index) => {
    const match = typeof entry?.match === "string" ? entry.match.trim() : "";
    const zone = typeof entry?.zone === "string" ? entry.zone : "";
    if (match === "") problems.push(`zones[${index}] has no match`);
    if (profile !== undefined && !profile.zones.some((candidate) => candidate.id === zone)) {
      problems.push(`zones[${index}].zone ${JSON.stringify(entry?.zone)} isn't a ${profile.style} zone`);
    }
    rules.push({ match, zone, reason: `proposed by a model: ${reason}`.slice(0, 200), by: "llm" });
  });
  if (problems.length > 0) throw new ArchitectureAdviceError(`the model's answer was unusable: ${problems.join("; ")}`);
  const confidence = (Object.values(Confidence) as unknown[]).includes(data.confidence) ? (data.confidence as Confidence) : Confidence.Low;
  return { rules: new ZoneRules(rules, profile!), reason, confidence };
}
