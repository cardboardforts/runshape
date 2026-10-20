/**
 * Paths come from data (a manifest names its scenario files, the webview names source files),
 * which anyone who can commit to the repository can write: refuse anything that would climb
 * out of the directory it's meant to be inside.
 */
export function safeSegments(relativePath: string): string[] {
  const segments = relativePath.split(/[\\/]/);
  if (/^([a-zA-Z]:)?[\\/]/.test(relativePath) || segments.some((segment) => segment === "..")) {
    throw new Error(`refusing a path outside its directory: ${relativePath}`);
  }
  return segments.filter((segment) => segment !== "" && segment !== ".");
}
