// Reviewing a saved comparison: open it as things to check off, keep what's checked and the
// comments in a draft beside it, and send the finished review through a comment sink. The
// review module decides; this loads, saves and logs.
import { CommentDelivery, CommentPreview, CommentSink, KeptReviewDrafts, Logger, ReviewComment, ReviewDraft, ReviewPage, ReviewVerdict } from "@runshape/kernel";
import { addComment, checkOff, draftFor, finishReview, progress, Reviewable, reviewables, ReviewProgress, unpinnedComments } from "@runshape/review";

export interface OpenedReview {
  page: ReviewPage;
  draft: ReviewDraft;
  progress: ReviewProgress[];
  /** On the change as a whole, or on what a later comparison no longer shows. */
  unpinned: ReviewComment[];
}

/** What sending did: shown and waiting for the person's OK, or delivered. */
export type Sent = { preview: CommentPreview; sink: string } | { delivered: CommentDelivery; sink: string } | { errors: string[] };

export class ReviewNotFound extends Error {}

export class Reviewing {
  constructor(
    private readonly reviews: KeptReviewDrafts,
    private readonly logger: Logger,
    private readonly now: () => Date,
  ) {}

  async open(name: string): Promise<OpenedReview> {
    const { page, draft, items } = await this.load(name);
    return { page, draft, progress: progress(draft, items), unpinned: unpinnedComments(draft, items) };
  }

  /** Checks off what's named (numbers from `open`'s list, or keys); what isn't there is said. */
  async check(name: string, named: string[]): Promise<{ errors: string[] }> {
    const { draft, items } = await this.load(name);
    const edit = checkOff(draft, items, named);
    await this.reviews.saveDraft(name, edit.draft);
    return { errors: edit.errors };
  }

  async comment(name: string, named: string, body: string): Promise<{ errors: string[] }> {
    const { draft, items } = await this.load(name);
    const edit = addComment(draft, items, named, body, this.now());
    if (edit.errors.length === 0) await this.reviews.saveDraft(name, edit.draft);
    return { errors: edit.errors };
  }

  /**
   * The finished review through a sink. Unconfirmed, it's only previewed: exactly what would be
   * sent, and where. Confirmed (the person saw the preview and said so), it's delivered.
   */
  async send(name: string, sink: CommentSink, verdict: ReviewVerdict, options: { confirmed: boolean }): Promise<Sent> {
    const { draft } = await this.load(name);
    const finished = finishReview(draft, verdict);
    if (finished.review === null) return { errors: finished.errors };
    // Counts and where, never the comments' text: the log is read by more people than the review.
    const fields = { review: name, sink: sink.name, verdict, comments: finished.review.comments.length };
    if (!options.confirmed) {
      const preview = sink.preview(finished.review);
      this.logger.log("info", "review.previewed", { ...fields, where: preview.where });
      return { preview, sink: sink.name };
    }
    try {
      const delivered = await sink.deliver(finished.review);
      this.logger.log("info", "review.sent", { ...fields, where: delivered.where });
      return { delivered, sink: sink.name };
    } catch (error) {
      // A sink refuses (the PR moved on since the review) or fails (gh, the network): the
      // person is told why rather than shown a stack. A timeout may still have posted, so
      // "refused or failed", not "not sent"; the sink says "nothing posted" when it knows.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.log("warn", "review.not_sent", { ...fields, error: reason });
      return { errors: [`${sink.name} refused or failed: ${reason}`] };
    }
  }

  private async load(name: string): Promise<{ page: ReviewPage; draft: ReviewDraft; items: Reviewable[] }> {
    const page = await this.reviews.page(name);
    if (page === null) throw new ReviewNotFound(`no review ${name}: \`compare\` makes one`);
    const draft = draftFor(name, page, await this.reviews.draft(name));
    return { page, draft, items: reviewables(page) };
  }
}
