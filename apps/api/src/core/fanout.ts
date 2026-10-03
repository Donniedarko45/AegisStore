import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '@aegis/shared';
import type { StageSink } from '@aegis/nodeclient';

/** Shannon entropy of a byte sample, in bits per byte (0 = constant, 8 = random/encrypted). */
export function entropyOf(sample: Buffer): number {
  if (sample.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const b of sample) counts[b]!++;
  let h = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / sample.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 1000) / 1000;
}

const ENTROPY_SAMPLE = 64 * 1024;

export interface FanoutResult {
  sha256: string;
  size: number;
  /** entropy of the first 64 KB (ransomware heuristics, §9.5) */
  entropy: number;
  /** sinks that failed while streaming; the others received every byte */
  failed: { sink: StageSink; error: Error }[];
}

/**
 * Stream one source to every sink in a single pass while computing SHA-256, size and an entropy
 * sample. Constant memory: honours backpressure from the slowest healthy node.
 *
 * A sink that fails mid-stream is dropped and the transfer continues with the others, as long as
 * at least `minSinks` remain; the caller then replaces the lost copies (next node on the ring).
 * Exceeding the size limit or the client aborting destroys every sink and rethrows.
 */
export async function fanoutStage(
  source: Readable,
  sinks: StageSink[],
  opts: { maxBytes: number; minSinks?: number },
): Promise<FanoutResult> {
  const hash = createHash('sha256');
  const minSinks = opts.minSinks ?? sinks.length;
  const failed: FanoutResult['failed'] = [];
  let live = [...sinks];
  let size = 0;
  const sample: Buffer[] = [];
  let sampled = 0;

  const drop = (sink: StageSink, error: Error) => {
    if (!live.includes(sink)) return;
    live = live.filter((s) => s !== sink);
    failed.push({ sink, error });
    sink.destroy(error);
    if (live.length < minSinks) throw new AppError(502, 'UPLOAD_FAILED', `Too many storage nodes failed while streaming: ${failed.map((f) => f.error.message).join('; ')}`);
  };

  try {
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > opts.maxBytes) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Object exceeds the ${opts.maxBytes} byte single-upload limit`);
      }
      hash.update(buf);
      if (sampled < ENTROPY_SAMPLE) {
        const part = buf.subarray(0, ENTROPY_SAMPLE - sampled);
        sample.push(part);
        sampled += part.length;
      }

      const waits: Promise<void>[] = [];
      for (const sink of [...live]) {
        if (sink.failed) {
          drop(sink, sink.failed);
          continue;
        }
        if (!sink.write(buf)) {
          // a sink that errors while we wait for it must not stall the others
          waits.push(Promise.race([sink.drained(), sink.errored]).catch((e: Error) => drop(sink, e)));
        }
      }
      if (waits.length) await Promise.all(waits);
    }
    for (const sink of [...live]) {
      if (sink.failed) drop(sink, sink.failed);
      else sink.end();
    }
  } catch (err) {
    for (const sink of live) sink.destroy(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return { sha256: hash.digest('hex'), size, entropy: entropyOf(Buffer.concat(sample)), failed };
}
