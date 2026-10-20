import { NodeFiles } from "@runshape/infra";

import type { RequestedReviews } from "./library";

export const REQUESTED_REVIEWS_FILE = "requested.json";
const REVIEW_JSON = "review.json";
export const REVIEW_MARKDOWN = "review.md";
const EXPLANATION_JSON = "explanation.json";
export const EXPLANATION_MARKDOWN = "explanation.md";

/** A comparison's folder: its base's and head's recording ids. */
export function reviewName(baseId: string, headId: string): string {
  return `${baseId}..${headId}`;
}

/**
 * The reviews kept beside the recordings (.runshape/reviews): a folder per comparison, holding
 * its review and the model's explanation of it, and the index of pull requests asking for one.
 * It knows where they go and that they're JSON; what's in them is core's.
 */
export class ReviewStore {
  constructor(private readonly files: NodeFiles) {}

  get directory(): string {
    return this.files.root;
  }

  /** review.json for tools, review.md to read or post. */
  async saveReview(name: string, bundle: unknown, markdown: string): Promise<void> {
    await this.files.writeText(`${name}/${REVIEW_JSON}`, asJson(bundle));
    await this.files.writeText(`${name}/${REVIEW_MARKDOWN}`, markdown);
  }

  /** The saved explanation; null when there's none, or it can't be read (it's asked again). */
  async explanation(name: string): Promise<unknown> {
    return this.files.readText(`${name}/${EXPLANATION_JSON}`).then((text) => JSON.parse(text) as unknown, () => null);
  }

  async saveExplanation(name: string, explanation: unknown, markdown: string): Promise<void> {
    await this.files.writeText(`${name}/${EXPLANATION_JSON}`, asJson(explanation));
    await this.files.writeText(`${name}/${EXPLANATION_MARKDOWN}`, markdown);
  }

  async dropExplanation(name: string): Promise<void> {
    await this.files.remove(`${name}/${EXPLANATION_JSON}`);
    await this.files.remove(`${name}/${EXPLANATION_MARKDOWN}`);
  }

  /** The last `review-requests` run's list; null before one has run. */
  async requested(): Promise<RequestedReviews | null> {
    const text = await this.files.readText(REQUESTED_REVIEWS_FILE).catch(() => null);
    return text === null ? null : (JSON.parse(text) as RequestedReviews);
  }

  /** `complete` is false while a run is still going (or was cut short): it lists what it got to. */
  async saveRequested(index: RequestedReviews, complete: boolean): Promise<void> {
    await this.files.writeText(REQUESTED_REVIEWS_FILE, asJson({ ...index, complete }));
  }

  /** Removes every review that compares this recording; says how many. */
  async forgetRecording(id: string): Promise<number> {
    const ofIt = (await this.files.list()).filter((name) => name.split("..").includes(id));
    for (const name of ofIt) await this.files.remove(name);
    return ofIt.length;
  }
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
