// Asking a language model where a component belongs. The model only proposes; a person
// accepts, and only then does it become a rule in hexvis.json. Everything here is pure so
// the prompt and the validation of the answer are testable without a model.
import { DeclaredRing } from "./rings";
import type { ComponentView } from "./views/component-view";
import type { GraphNode, SystemGraph } from "./views/system-graph";

/** Port: send one prompt to a model, get its text back. */
export interface RingAdvisor {
  readonly available: boolean;
  complete(prompt: string): Promise<string>;
}

export enum Confidence {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export interface RingAdvice {
  ring: DeclaredRing;
  reason: string;
  confidence: Confidence;
}

export class RingAdviceError extends Error {}

/** What the recording shows about one component: the evidence the model reasons from. */
export interface RingFacts {
  qualifiedName: string;
  currentRing: string;
  currentReason: string;
  functions: string[];
  calledBy: string[];
  calls: string[];
  externalSystems: string[];
}

const MAX_NEIGHBOURS = 20;
const MAX_SOURCE_LINES = 120;

export function ringFacts(graph: SystemGraph, node: GraphNode, view: ComponentView): RingFacts {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const describe = (id: string) => {
    const other = byId.get(id);
    return other ? `${other.qualifiedName ?? other.label} (${other.ring})` : id;
  };
  const incoming = graph.edges.filter((edge) => edge.to === node.id).map((edge) => describe(edge.from));
  const outgoing = graph.edges.filter((edge) => edge.from === node.id && !edge.to.startsWith("external:")).map((edge) => describe(edge.to));
  const externals = graph.edges.filter((edge) => edge.from === node.id && edge.to.startsWith("external:")).map((edge) => edge.to.slice("external:".length));
  return {
    qualifiedName: node.qualifiedName ?? node.label,
    currentRing: node.ring,
    currentReason: node.ringReason,
    functions: view.functions.map((fn) => `${fn.name}${fn.inheritedFrom ? ` (from ${fn.inheritedFrom})` : ""}`),
    calledBy: incoming.slice(0, MAX_NEIGHBOURS),
    calls: outgoing.slice(0, MAX_NEIGHBOURS),
    externalSystems: externals,
  };
}

export function ringAdvicePrompt(facts: RingFacts, source: string[] | null): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `  - ${item}`).join("\n") : "  (none)");
  const code = source ? source.slice(0, MAX_SOURCE_LINES).join("\n") : "(source not available)";
  return `You are reviewing a Python web application against onion / hexagonal architecture.
Rings:
- inbound-adapter: turns a request (HTTP, CLI, message) into calls on the core; framework-facing.
- core: domain entities, value objects and application services; no framework or I/O knowledge.
- outbound-adapter: implements a port by talking to the outside world (database, HTTP API, queue).

Decide which ring this component is MEANT to be in. Base it on its responsibility, not only on
what it currently does: if it is a domain object that currently talks to the database, it is
still core (and that is a violation worth naming in the reason).

Component: ${facts.qualifiedName}
Currently shown as: ${facts.currentRing} (${facts.currentReason})
Functions:
${list(facts.functions)}
Called by (component and its ring), as recorded while the tests ran:
${list(facts.calledBy)}
Calls:
${list(facts.calls)}
External systems it calls directly:
${list(facts.externalSystems)}

Source:
\`\`\`python
${code}
\`\`\`

Answer with only a JSON object, no prose around it:
{"ring": "inbound-adapter" | "core" | "outbound-adapter", "reason": "<one or two sentences>", "confidence": "low" | "medium" | "high"}`;
}

/** Models wrap JSON in prose or code fences; take the first object and validate it strictly. */
export function parseRingAdvice(text: string): RingAdvice {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new RingAdviceError("the model did not answer with a JSON object");
  let data: Partial<RingAdvice>;
  try {
    data = JSON.parse(text.slice(start, end + 1)) as Partial<RingAdvice>;
  } catch {
    throw new RingAdviceError("the model's answer was not valid JSON");
  }
  const problems: string[] = [];
  if (!(Object.values(DeclaredRing) as string[]).includes(data.ring as string)) problems.push(`unknown ring ${JSON.stringify(data.ring)}`);
  if (typeof data.reason !== "string" || data.reason.trim() === "") problems.push("no reason given");
  const confidence = (Object.values(Confidence) as string[]).includes(data.confidence as string) ? (data.confidence as Confidence) : Confidence.Low;
  if (problems.length > 0) throw new RingAdviceError(`the model's answer was unusable: ${problems.join("; ")}`);
  return { ring: data.ring as DeclaredRing, reason: data.reason!.trim(), confidence };
}
