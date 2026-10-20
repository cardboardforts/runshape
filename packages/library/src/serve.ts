import { NodeFiles } from "@runshape/infra";

import { RecordingLibrary } from "./library";

export interface ServedFile {
  status: 200 | 404;
  body: string;
}

/**
 * A file inside the recordings directory, by its path relative to it, for the demo's dev
 * server: nothing outside it, whatever "..", and no directory listings.
 */
export async function serveLibraryFile(directory: string, relativePath: string): Promise<ServedFile> {
  // Outside it, a link out of it, a folder (no listings) or nothing there: all just not found.
  return new NodeFiles(directory).readTextWithin(relativePath).then(
    (body) => ({ status: 200, body }),
    () => ({ status: 404, body: "" }),
  );
}

export interface LibraryResponse {
  status: 200 | 404 | 500;
  contentType: string;
  body: string;
}

/** Where the demo's dev server answers for the library; every other URL is the dev server's own. */
export const LIBRARY_ROUTE = "/__runshape/";

/**
 * The demo's dev-server routes, free of any server framework: the overview at
 * /__runshape/library, recordings' files under /__runshape/recordings/ and reviews' under
 * /__runshape/reviews/. Null for any other URL.
 */
export async function handleLibraryRequest(library: RecordingLibrary, url: string): Promise<LibraryResponse | null> {
  const path = url.split("?")[0]!;
  if (!path.startsWith(LIBRARY_ROUTE)) return null;
  const route = path.slice(LIBRARY_ROUTE.length);
  if (route === "library") {
    try {
      return { status: 200, contentType: "application/json", body: JSON.stringify(await library.overview()) };
    } catch (error) {
      return { status: 500, contentType: "text/plain", body: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const [prefix, directory] of [["recordings/", library.store.directory], ["reviews/", library.reviews.directory]] as const) {
    if (!route.startsWith(prefix)) continue;
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(route.slice(prefix.length));
    } catch {
      return NOT_FOUND;
    }
    const file = await serveLibraryFile(directory, relativePath);
    // Only what's meant to be read: a review's Markdown (as text), and JSON. Not logs.
    if (!/\.(md|json)$/.test(relativePath)) return NOT_FOUND;
    return file.status === 200 ? { status: 200, contentType: relativePath.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json", body: file.body } : NOT_FOUND;
  }
  return NOT_FOUND;
}

const NOT_FOUND: LibraryResponse = { status: 404, contentType: "text/plain", body: "" };
