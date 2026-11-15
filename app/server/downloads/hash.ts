// @effect-diagnostics-next-line nodeBuiltinImport:off Digest of effect is one-shot over one Uint8Array: a GiB file is hashed as it streams
import { createHash, type Hash } from 'node:crypto';

/** A sha256 fed chunk by chunk: `copy` forks its state, `hex` ends it with the digest. */
export interface Sha256 {
  readonly update: (chunk: Uint8Array) => void;
  readonly copy: () => Sha256;
  readonly hex: () => string;
}

const wrap = (hash: Hash): Sha256 => ({
  update: (chunk) => {
    hash.update(chunk);
  },
  copy: () => wrap(hash.copy()),
  hex: () => hash.digest('hex'),
});

/** A new sha256, of no bytes yet. */
export const sha256 = (): Sha256 => wrap(createHash('sha256'));
