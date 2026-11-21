// Small text helpers.

/** A URL-safe slug: lower case, words joined by single dashes. */
export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-/, "");
}

/** The number of words in the text. */
export function wordCount(text) {
  return text.split(/\s+/).length;
}

/** Each word starts with a capital letter, the rest lower case. */
export function titleCase(text) {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
