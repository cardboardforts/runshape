import { createHash } from "node:crypto";

/** A hash being built: each update adds to it, in order. */
interface Digest {
  update(chunk: string | Uint8Array): Digest;
  hex(): string;
}

/** SHA-256 from Node's crypto: fits the kernel's Hashing port by shape. */
export const nodeHashing = {
  sha256: (text: string): string => createHash("sha256").update(text).digest("hex"),
  digest(): Digest {
    const hash = createHash("sha256");
    const digest: Digest = {
      update(chunk) {
        hash.update(chunk);
        return digest;
      },
      hex: () => hash.digest("hex"),
    };
    return digest;
  },
};
