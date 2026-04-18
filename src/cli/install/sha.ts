/**
 * SHA-256 helpers for the install manifest (G12). Lowercase hex, 64 chars.
 *
 * Reads source files via streaming so large files don't balloon memory —
 * even though our canonical files are all small, the same helper is used
 * for consumer-side drift detection and we don't want a surprise.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256OfBuffer(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
