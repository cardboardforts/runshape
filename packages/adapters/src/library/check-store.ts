// The last `runshape check` and the person's OK to go past it (.runshape/checks): JSON files,
// each written whole. What's in them is the check workflow's.
import { join } from "node:path";

import { KeptChecks } from "@runshape/kernel";
import { NodeFiles } from "@runshape/infra";

const LAST = "last.json";
const BYPASS = "bypass.json";

export class CheckStore implements KeptChecks {
  constructor(
    private readonly files: NodeFiles,
    /** How a person finds the folder from the project's root (".runshape/checks"), for messages. */
    private readonly shownAs: string,
  ) {}

  get shownLast(): string {
    return join(this.shownAs, LAST);
  }

  last(): Promise<unknown> {
    return this.read(LAST);
  }

  bypass(): Promise<unknown> {
    return this.read(BYPASS);
  }

  // Whole or not at all: a gate reading half a result, or half an OK, would decide on nothing.
  async saveLast(result: unknown): Promise<void> {
    await this.files.replaceText(LAST, asJson(result));
  }

  async saveBypass(bypass: unknown): Promise<void> {
    await this.files.replaceText(BYPASS, asJson(bypass));
  }

  /** null only when there's no such file; one that isn't JSON throws (the gate fails closed on it). */
  private async read(file: string): Promise<unknown> {
    let text: string;
    try {
      text = await this.files.readText(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${join(this.shownAs, file)} isn't JSON (${error instanceof Error ? error.message : String(error)}): move it aside`);
    }
  }
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
