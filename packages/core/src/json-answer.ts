// Reading the JSON a model was asked to answer with, from whatever text it wrapped it in.

/** The first `{…}` in the answer that parses, scanning braces outside strings: prose around it can hold braces too. */
export function firstJsonObject(answer: string): Record<string, unknown> | null {
  for (let start = answer.indexOf("{"); start !== -1; start = answer.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < answer.length; i += 1) {
      const char = answer[i];
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          const value = JSON.parse(answer.slice(start, i + 1)) as unknown;
          if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
        } catch {
          // not JSON after all: try the next opening brace
        }
        break;
      }
    }
  }
  return null;
}
