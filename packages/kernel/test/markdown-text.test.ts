/**
 * Text other people wrote (a PR title, a ticket's, a model's answer) goes into Markdown that
 * may be posted as a PR comment. There it must read as typed and do nothing: no image that
 * loads from anywhere, no tag, no link, and no @mention or #123 that notifies someone or
 * cross-references an issue from the reviewer's account. A zero-width space breaks the last
 * three without changing what a person reads.
 */
import { expect, test } from "vitest";

import { plainMarkdown } from "../src";

test("one line, Markdown and HTML escaped, mentions, links and references broken by a zero-width space", () => {
  const z = "​";

  expect(plainMarkdown("Refuse ![x](https://evil.example/a.png) <img src=x>\n  thanks @octocat, see #12 and www.evil.example; `code` *bold* a_b")).toBe(
    `Refuse \\!\\[x\\](https:${z}//evil.example/a.png) \\<img src=x\\> thanks @${z}octocat, see #${z}12 and www${z}.evil.example; \\\`code\\\` \\*bold\\* a\\_b`,
  );
});
