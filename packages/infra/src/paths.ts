/**
 * Paths come from trace files and the webview, which are data: refuse anything that would
 * climb out of the directory it's meant to be inside.
 */
export function safeSegments(relativePath: string): string[] {
  const segments = relativePath.split(/[\\/]/);
  if (/^([a-zA-Z]:)?[\\/]/.test(relativePath) || segments.some((segment) => segment === "..")) {
    throw new Error(`refusing a path outside the project: ${relativePath}`);
  }
  return segments.filter((segment) => segment !== "" && segment !== ".");
}
