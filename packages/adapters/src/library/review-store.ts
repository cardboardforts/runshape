import { join } from "node:path";

import { KeptReviewDrafts, KeptReviews, RequestedReviews, ReviewDraft, ReviewPage } from "@runshape/kernel";
import { NodeFiles } from "@runshape/infra";

export const REQUESTED_REVIEWS_FILE = "requested.json";
const REVIEW_JSON = "review.json";
const REVIEW_MARKDOWN = "review.md";
const REVIEW_PAGE = "page.json";
const EXPLANATION_JSON = "explanation.json";
const EXPLANATION_MARKDOWN = "explanation.md";
const REVIEW_DRAFT = "review-draft.json";

/**
 * The reviews kept beside the recordings (.runshape/reviews): a folder per comparison, holding
 * its review and the model's explanation of it, and the index of pull requests asking for one.
 * It knows where they go and that they're JSON; what's in them is core's.
 */
export class ReviewStore implements KeptReviews, KeptReviewDrafts {
  constructor(
    private readonly files: NodeFiles,
    /** How a person finds the store from the project's root (".runshape/reviews"), for messages. */
    private readonly shownAs: string,
  ) {}

  shownReview(name: string): string {
    return join(this.shownAs, name, REVIEW_MARKDOWN);
  }

  shownExplanation(name: string): string {
    return join(this.shownAs, name, EXPLANATION_MARKDOWN);
  }

  get directory(): string {
    return this.files.root;
  }

  /** review.json for tools, review.md to read or post. */
  async saveReview(name: string, bundle: unknown, markdown: string, page: unknown): Promise<void> {
    // The bundle last: cut short, the files beside an older review.json are newer than it, never a
    // new review beside an older page that would read as its own.
    await this.files.writeText(`${name}/${REVIEW_PAGE}`, asJson(page));
    await this.files.writeText(`${name}/${REVIEW_MARKDOWN}`, markdown);
    await this.files.writeText(`${name}/${REVIEW_JSON}`, asJson(bundle));
  }

  async savePage(name: string, page: unknown): Promise<void> {
    await this.files.writeText(`${name}/${REVIEW_PAGE}`, asJson(page));
  }

  /** The PR page; null when there's no such review. Any other failure, or a file that isn't a page, throws. */
  async page(name: string): Promise<ReviewPage | null> {
    return this.readVersioned<ReviewPage>(name, REVIEW_PAGE, "runshape-review-page");
  }

  /** What's checked and the comments so far; null before the first. A file that isn't a version 1 draft throws. */
  async draft(name: string): Promise<ReviewDraft | null> {
    return this.readVersioned<ReviewDraft>(name, REVIEW_DRAFT, "runshape-review-draft");
  }

  /** Whole or not at all: a draft cut short mid-write would lose every check and comment. */
  async saveDraft(name: string, draft: ReviewDraft): Promise<void> {
    await this.files.replaceText(`${name}/${REVIEW_DRAFT}`, asJson(draft));
  }

  /** A JSON file of a known format, version 1; null only when there's no such file. */
  private async readVersioned<T>(name: string, file: string, format: string): Promise<T | null> {
    const where = join(this.shownAs, name, file);
    let text: string;
    try {
      text = await this.files.readText(`${name}/${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: { format?: unknown; version?: unknown };
    try {
      value = JSON.parse(text) as { format?: unknown; version?: unknown };
    } catch (error) {
      throw new Error(`${where} isn't JSON (${error instanceof Error ? error.message : String(error)}): move it aside to start again`);
    }
    if (value?.format !== format || value.version !== 1) {
      throw new Error(`${where} is ${JSON.stringify(value?.format)} version ${JSON.stringify(value?.version)}, not ${format} version 1: move it aside to start again`);
    }
    return value as T;
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
