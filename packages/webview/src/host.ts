import type { UiRequest, UiResponse } from "@runshape/kernel";

/** Where the webview's requests go: the VS Code extension, or the standalone demo. */
export interface Host {
  post(request: UiRequest): void;
  subscribe(listener: (response: UiResponse) => void): () => void;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export function vscodeHost(): Host {
  const api = acquireVsCodeApi();
  return {
    post: (request) => api.postMessage(request),
    subscribe(listener) {
      const onMessage = (event: MessageEvent<UiResponse>) => listener(event.data);
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    },
  };
}
