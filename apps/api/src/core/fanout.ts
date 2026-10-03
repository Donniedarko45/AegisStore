import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '@aegis/shared';
import type { StageSink } from './storageclient';

/**
 * Stream one source to every sink in a single pass while computing SHA-256 and size.
 * Constant memory: honours backpressure from the slowest node. Any sink failing, the size
 * limit being exceeded, or the client aborting destroys every sink and rethrows.
 */
export async function fanoutStage(
  source: Readable,
  sinks: StageSink[],
  opts: { maxBytes: number },
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > opts.maxBytes) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Object exceeds the ${opts.maxBytes} byte single-upload limit`);
      }
      hash.update(buf);

      const waits: Promise<void>[] = [];
      for (const sink of sinks) {
        if (sink.failed) throw sink.failed;
        if (!sink.write(buf)) waits.push(sink.drained());
      }
      if (waits.length) await Promise.race([Promise.all(waits), ...sinks.map((s) => s.errored)]);
    }
    for (const sink of sinks) {
      if (sink.failed) throw sink.failed;
      sink.end();
    }
  } catch (err) {
    for (const sink of sinks) sink.destroy(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return { sha256: hash.digest('hex'), size };
}
