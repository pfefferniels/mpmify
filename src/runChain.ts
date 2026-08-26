/**
 * Run a chain of fitters over an alignment, and give back the MPM it writes.
 *
 * The alignment is a parameter rather than something this builds: where it comes from — an MEI
 * with its own alignment vocabulary, a frozen fixture, a host application — is the caller's
 * business, and the chain does not care. What is here is the part that is the same either way:
 * check the order, substitute the metadata call, run the chain in registry order.
 *
 * The chain arrives already built, so a caller that adds a transformer of its own registers it
 * and imports the work file itself; {@link importWork} is what turns a saved file into one.
 */
import type { Alignment } from './alignment/index.js';
import { createMpm, exportMPM, type Mpm } from './mpm/index.js';
import { compareTransformers, validate } from './transformers/Order.js';
import { InsertMetadata } from './transformers/metadata/InsertMetadata.js';
import type { Transformer } from './transformers/Transformer.js';

export interface ChainRun {
  /** The chain as it ran: the calls handed in, metadata substituted, in registry order. */
  transformers: Transformer[];
  mpm: Mpm;
  /** The chain's MPM, serialized. */
  mpmXml: string;
  /** What the substituted `InsertMetadata` was built from. */
  title: string;
  author: string;
}

/**
 * @param alignment the score and the recording it is fitted to. The chain writes through it —
 * `MakeChoice` and `Modify` edit the observations — so a caller that also wants the recording
 * untouched needs a second one.
 * @throws when the chain names a transformer that is not registered, or one whose `requires` is
 * not satisfied by what runs before it
 */
export const runChain = (alignment: Alignment, chain: Transformer[]): ChainRun => {
  const messages = validate(chain);
  if (messages.length) throw new Error(messages.map((m) => m.message).join('\n'));

  const metadata = chain.find((t): t is InsertMetadata => t instanceof InsertMetadata);
  const title = metadata?.options.comments?.[0]?.text ?? '';
  const author = metadata?.options.authors?.[0]?.text ?? '';

  // the imported `InsertMetadata` is dropped and a fresh one built from the title and author it
  // carried, so a document and a reconstruction state their metadata through one code path. it
  // belongs to no segment: it writes `<metadata>`, not an instruction.
  const transformers: Transformer[] = [
    new InsertMetadata({
      authors: author ? [{ number: 0, text: author }] : [],
      comments: title ? [{ text: title }] : [],
    }),
    ...chain.filter((t) => t.name !== 'InsertMetadata'),
  ].sort(compareTransformers);

  const mpm = createMpm();
  for (const transformer of transformers) transformer.run(alignment, mpm);

  return { transformers, mpm, mpmXml: exportMPM(mpm), title, author };
};
