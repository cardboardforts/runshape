// Someone else's text in Markdown that may be posted (a PR comment): see markdown-text.test.ts.

/** Zero-width space: invisible, but it stops GitHub reading what follows as a mention, a link or a reference. */
const BREAK = "​";

/**
 * Text as one line of plain Markdown: whitespace collapsed, every character Markdown or HTML
 * would act on escaped, and what GitHub would turn into a notification or a link broken
 * apart: @mentions, bare URLs, #123 references.
 */
export function plainMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>!|~&]/g, (c) => `\\${c}`)
    .replace(/@(?=[\w-])/g, `@${BREAK}`)
    .replace(/:\/\//g, `:${BREAK}//`)
    .replace(/#(?=\d)/g, `#${BREAK}`)
    .replace(/\bwww\./gi, (www) => `${www.slice(0, 3)}${BREAK}.`);
}
