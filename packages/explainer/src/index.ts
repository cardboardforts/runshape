// The explainer module: why a change was made, as its authors said, beside what it did. It
// takes the review's Markdown and the commit messages as values, asks a language model, and
// returns the explanation, checked. Its prompt and how it reads the answer are its own.
export * from "./explainer";
