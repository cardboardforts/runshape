import { createHash } from "node:crypto";

import { Digest, Hashing } from "@runshape/kernel";

/** SHA-256 from Node's crypto (core's Hashing port). */
export const nodeHashing: Hashing = {
  sha256: (text) => createHash("sha256").update(text).digest("hex"),
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
