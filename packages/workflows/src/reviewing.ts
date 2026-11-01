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

/** What sending did: shown (with the digest a post must match), delivered, or refused. */
export type Sent = { preview: CommentPreview; digest: string; sink: string } | { delivered: CommentDelivery; sink: string } | { errors: string[] };

/**
 * How to send: `preview` shows and remembers it; `post` sends only what was last previewed for
 * that destination (outward: the person saw exactly this); `deliver` sends without a preview
 * (a sink that stays on this machine).
 */
export enum SendMode {
  Preview = "preview",
  Post = "post",
  Deliver = "deliver",
}

/** Hex digits of a preview's digest the person sees: enough to tell two previews apart. */
export const SHOWN_DIGEST_LENGTH = 12;

/** No review by that name, or one whose files can't be read: said to the person as it is. */
export class ReviewNotFound extends Error {}

export class Reviewing {
  constructor(
    private readonly reviews: KeptReviewDrafts,
    private readonly logger: Logger,
    private readonly now: () => Date,
    /** Hashing's sha256: what a preview's digest is. */
    private readonly digest: (text: string) => string,
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

  /** The finished review through a sink: previewed, posted as previewed, or delivered (see SendMode). */
  async send(name: string, sink: CommentSink, verdict: ReviewVerdict, mode: SendMode): Promise<Sent> {
    const { draft } = await this.load(name);
    const finished = finishReview(draft, verdict);
    if (finished.review === null) return { errors: finished.errors };
    // Counts and where, never the comments' text: the log is read by more people than the review.
    const fields = { review: name, sink: sink.name, verdict, comments: finished.review.comments.length };
    let preview: CommentPreview;
    try {
      preview = await sink.preview(finished.review);
    } catch (error) {
      // Where it would go couldn't be found (no such PR, gh not logged in): nothing was sent.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.log("warn", "review.not_previewed", { ...fields, error: reason });
      return { errors: [`${sink.name} can't be sent to: ${reason}`] };
    }
    const digest = this.digest(`${preview.where}\n${preview.text}`).slice(0, SHOWN_DIGEST_LENGTH);
    if (mode === SendMode.Preview) {
      await this.reviews.saveDraft(name, { ...draft, previewed: { where: preview.where, digest } });
      this.logger.log("info", "review.previewed", { ...fields, where: preview.where, digest });
      return { preview, digest, sink: sink.name };
    }
    if (mode === SendMode.Post) {
      const shown = draft.previewed ?? null;
      if (shown === null || shown.where !== preview.where || shown.digest !== digest) {
        this.logger.log("warn", "review.not_previewed", { ...fields, where: preview.where });
        const why = shown === null ? "it hasn't been previewed" : "it isn't what was last previewed";
        return { errors: [`not posted: ${why}. Send it without --post to see exactly what would be posted, then post that.`] };
      }
    }
    try {
      const delivered = await sink.deliver(finished.review);
      this.logger.log("info", "review.sent", { ...fields, where: delivered.where });
      // A post is used up: posting again needs another look.
      if (mode === SendMode.Post) await this.reviews.saveDraft(name, { ...draft, previewed: null });
      return { delivered, sink: sink.name };
    } catch (error) {
      // A sink refuses (the PR moved on since the review) or fails (gh, the network): the
      // person is told why rather than shown a stack. A timeout may still have posted, so
      // "refused or failed", not "not sent"; the sink says which when it knows.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.log("warn", "review.not_sent", { ...fields, error: reason });
      return { errors: [`${sink.name} refused or failed: ${reason}`] };
    }
  }

  private async load(name: string): Promise<{ page: ReviewPage; draft: ReviewDraft; items: Reviewable[] }> {
    let page: ReviewPage | null;
    let saved: ReviewDraft | null;
    try {
      [page, saved] = await Promise.all([this.reviews.page(name), this.reviews.draft(name)]);
    } catch (error) {
      throw new ReviewNotFound(`can't read review ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (page === null) throw new ReviewNotFound(`no review ${name}: \`compare\` makes one`);
    const draft = draftFor(name, page, saved);
    return { page, draft, items: reviewables(page) };
  }
}
