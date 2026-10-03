import { open, stat } from 'node:fs/promises';

/** Invert 16 bytes in the middle of a file (keeps its size, breaks its SHA-256). */
export async function flipBytes(file: string): Promise<void> {
  const { size } = await stat(file);
  if (size === 0) return;
  const at = Math.floor(size / 2);
  const len = Math.min(16, size - at);
  const fh = await open(file, 'r+');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, at);
    for (let i = 0; i < len; i++) buf[i] = buf[i]! ^ 0xff;
    await fh.write(buf, 0, len, at);
    await fh.sync();
  } finally {
    await fh.close();
  }
}
