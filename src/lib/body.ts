export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Reads a request body as raw bytes without ever holding more than `maxBytes`.
 *
 * A declared Content-Length above the limit is rejected before the body is touched. The header
 * can be absent (chunked uploads) or wrong, so the stream itself is also counted and cancelled
 * as soon as it goes over.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
