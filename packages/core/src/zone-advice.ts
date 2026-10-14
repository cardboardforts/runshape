// Asking a language model where a component belongs. The model only proposes; a person
// accepts, and only then does it become a rule in runshape.json. Everything here is pure so
// the prompt and the validation of the answer are testable without a model.
import { ArchitectureProfile } from "./profiles";
import type { ComponentView } from "./views/component-view";
import type { GraphNode, SystemGraph } from "./views/system-graph";

/** Port: send one prompt to a model, get its text back. */
export interface ZoneAdvisor {
  readonly available: boolean;
  complete(prompt: string): Promise<string>;
}

export enum Confidence {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export interface ZoneAdvice {
  zone: string;
  reason: string;
  confidence: Confidence;
}

export class ZoneAdviceError extends Error {}

/** What the recording shows about one component: the evidence the model reasons from. */
export interface ZoneFacts {
  qualifiedName: string;
  currentZone: string;
  currentReason: string;
  functions: string[];
  calledBy: string[];
  calls: string[];
  externalSystems: string[];
}

const MAX_NEIGHBOURS = 20;
const MAX_SOURCE_LINES = 120;

export function zoneFacts(graph: SystemGraph, node: GraphNode, view: ComponentView): ZoneFacts {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const describe = (id: string) => {
    const other = byId.get(id);
    return other ? `${other.qualifiedName ?? other.label} (${other.zone})` : id;
  };
  const incoming = graph.edges.filter((edge) => edge.to === node.id).map((edge) => describe(edge.from));
  const outgoing = graph.edges.filter((edge) => edge.from === node.id && !edge.to.startsWith("external:")).map((edge) => describe(edge.to));
  const externals = graph.edges.filter((edge) => edge.from === node.id && edge.to.startsWith("external:")).map((edge) => edge.to.slice("external:".length));
  return {
    qualifiedName: node.qualifiedName ?? node.label,
    currentZone: node.zone,
    currentReason: node.zoneReason,
    functions: view.functions.map((fn) => `${fn.name}${fn.inheritedFrom ? ` (from ${fn.inheritedFrom})` : ""}`),
    calledBy: incoming.slice(0, MAX_NEIGHBOURS),
    calls: outgoing.slice(0, MAX_NEIGHBOURS),
    externalSystems: externals,
  };
}

/** How a prompt names the language a run was recorded in; others go as recorded. */
const LANGUAGE_NAMES: Record<string, string> = { python: "Python", typescript: "TypeScript" };

export function languageName(language: string): string {
  return LANGUAGE_NAMES[language] ?? language;
}

/** `language` is Run.language: it names the app and tags the source's code fence. */
export function zoneAdvicePrompt(facts: ZoneFacts, source: string[] | null, profile: ArchitectureProfile, language: string): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `  - ${item}`).join("\n") : "  (none)");
  const code = source ? source.slice(0, MAX_SOURCE_LINES).join("\n") : "(source not available)";
  const zones = profile.zones.map((zone) => `- ${zone.id}: ${zone.meaning}.`).join("\n");
  const answers = profile.zones.map((zone) => JSON.stringify(zone.id)).join(" | ");
  return `You are reviewing a ${languageName(language)} application against this architecture: ${profile.name}.
Zones:
${zones}

Decide which zone this component is MEANT to be in. Base it on its responsibility, not only on
what it currently does: if its role belongs in one zone but it currently behaves like another
(for example a domain object that queries the database), choose the zone it is meant for and
name the mismatch in the reason.

Component: ${facts.qualifiedName}
Currently shown as: ${facts.currentZone} (${facts.currentReason})
Functions:
${list(facts.functions)}
Called by (component and its zone), as recorded while the tests ran:
${list(facts.calledBy)}
Calls:
${list(facts.calls)}
External systems it calls directly:
${list(facts.externalSystems)}

Source:
\`\`\`${language}
${code}
\`\`\`

Answer with only a JSON object, no prose around it:
{"zone": ${answers}, "reason": "<one or two sentences>", "confidence": "low" | "medium" | "high"}`;
}

/** Models wrap JSON in prose or code fences; take the first object and validate it strictly. */
export function parseZoneAdvice(text: string, profile: ArchitectureProfile): ZoneAdvice {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ZoneAdviceError("the model did not answer with a JSON object");
  let data: Partial<ZoneAdvice>;
  try {
    data = JSON.parse(text.slice(start, end + 1)) as Partial<ZoneAdvice>;
  } catch {
    throw new ZoneAdviceError("the model's answer was not valid JSON");
  }
  const problems: string[] = [];
  if (!profile.zones.some((zone) => zone.id === data.zone)) problems.push(`unknown zone ${JSON.stringify(data.zone)}`);
  if (typeof data.reason !== "string" || data.reason.trim() === "") problems.push("no reason given");
  const confidence = (Object.values(Confidence) as string[]).includes(data.confidence as string) ? (data.confidence as Confidence) : Confidence.Low;
  if (problems.length > 0) throw new ZoneAdviceError(`the model's answer was unusable: ${problems.join("; ")}`);
  return { zone: data.zone!, reason: data.reason!.trim(), confidence };
}
