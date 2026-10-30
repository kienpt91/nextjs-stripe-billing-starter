import { describe, expect, it } from 'vitest';
import { MAX_WEBHOOK_BODY_BYTES, handleStripeWebhook } from '@/billing/handlers/webhook';
import { BodyTooLargeError, readBodyLimited } from '@/lib/body';
import { T0, WEBHOOK_SECRET, createContext, signedWebhookRequest, signingStripe, subscriptionEvent, subscriptionObject } from './helpers';

const URL = 'http://localhost/api/stripe/webhook';

interface CountingRequest {
  request: Request;
  chunksPulled: () => number;
}

/** A request whose body is a stream of `chunkCount` chunks, with no Content-Length unless given. */
function streamedRequest(chunkCount: number, chunkBytes: number, headers: Record<string, string> = {}): CountingRequest {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled < chunkCount) {
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      } else {
        controller.close();
      }
    },
  });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body: stream, duplex: 'half' };
  return { request: new Request(URL, init), chunksPulled: () => pulled };
}

/** A correctly signed event whose JSON body is exactly `bytes` long. */
function signedRequestOfSize(bytes: number): Request {
  const event = subscriptionEvent('customer.subscription.updated', T0, subscriptionObject());
  const emptyPadding = JSON.stringify({ ...event, padding: '' });
  const padding = 'x'.repeat(bytes - Buffer.byteLength(emptyPadding));
  const payload = JSON.stringify({ ...event, padding });
  expect(Buffer.byteLength(payload)).toBe(bytes);
  return signedWebhookRequest(payload);
}

describe('readBodyLimited', () => {
  it('returns the exact bytes of a body within the limit, across several chunks', async () => {
    const request = new Request(URL, { method: 'POST', body: new Uint8Array([1, 2, 3, 4, 5]) });
    expect([...(await readBodyLimited(request, 5))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty array when there is no body', async () => {
    expect((await readBodyLimited(new Request(URL, { method: 'POST' }), 10)).byteLength).toBe(0);
  });

  it('throws as soon as the streamed total passes the limit, without draining the rest', async () => {
    const { request, chunksPulled } = streamedRequest(1000, 1024);

    await expect(readBodyLimited(request, 4096)).rejects.toBeInstanceOf(BodyTooLargeError);

    expect(chunksPulled()).toBeLessThan(20);
  });

  it('ignores a non-numeric Content-Length and relies on counting the stream', async () => {
    const { request } = streamedRequest(10, 1024, { 'content-length': 'lots' });
    await expect(readBodyLimited(request, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('POST /api/stripe/webhook body size', () => {
  it('rejects an oversized declared Content-Length with 413 before reading the body or verifying anything', async () => {
    const ctx = createContext();
    let verifications = 0;
    // Count verification calls on a copy: the SDK's `webhooks` helper is shared by every test.
    const deps = {
      ...ctx.deps,
      stripe: {
        ...ctx.deps.stripe,
        webhooks: {
          constructEvent: (...args: Parameters<typeof signingStripe.webhooks.constructEvent>) => {
            verifications += 1;
            return signingStripe.webhooks.constructEvent(...args);
          },
        },
      },
    };
    const { request, chunksPulled } = streamedRequest(100, 1024, {
      'stripe-signature': 't=1,v1=00',
      'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1),
    });

    const response = await handleStripeWebhook(request, deps);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
    expect(verifications).toBe(0);
    // The stream primes one chunk when it is created; nothing more was read.
    expect(chunksPulled()).toBeLessThanOrEqual(1);
    expect(ctx.logs.some((log) => log.message === 'webhook_body_too_large')).toBe(true);
  });

  it('rejects a streamed body with no Content-Length once it passes the limit', async () => {
    const ctx = createContext();
    const { request, chunksPulled } = streamedRequest(200, 64 * 1024, { 'stripe-signature': 't=1,v1=00' });

    const response = await handleStripeWebhook(request, ctx.deps);

    expect(response.status).toBe(413);
    // 200 x 64 KiB is 12.5 MiB offered; the limit is 1 MiB (16 chunks).
    expect(chunksPulled()).toBeLessThan(25);
  });

  it('rejects a body that is larger than its Content-Length claims', async () => {
    const ctx = createContext();
    const { request } = streamedRequest(40, 64 * 1024, { 'stripe-signature': 't=1,v1=00', 'content-length': '10' });
    expect((await handleStripeWebhook(request, ctx.deps)).status).toBe(413);
  });

  it('accepts a correctly signed body of exactly the maximum size', async () => {
    const ctx = createContext();

    const response = await handleStripeWebhook(signedRequestOfSize(MAX_WEBHOOK_BODY_BYTES), ctx.deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'processed' });
    expect((await ctx.repo.getSubscription('sub_1'))?.status).toBe('active');
  });

  it('rejects a body one byte over the maximum even though it is correctly signed', async () => {
    const ctx = createContext();

    const response = await handleStripeWebhook(signedRequestOfSize(MAX_WEBHOOK_BODY_BYTES + 1), ctx.deps);

    expect(response.status).toBe(413);
    expect(await ctx.repo.getSubscription('sub_1')).toBeNull();
  });

  it('still verifies signatures on the raw bytes of normal bodies', async () => {
    const ctx = createContext();
    const event = subscriptionEvent('customer.subscription.updated', T0, subscriptionObject());
    const payload = JSON.stringify(event);
    const header = signingStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    // Same bytes plus a trailing newline: a re-serialised or normalised body would not match the signature.
    const request = new Request(URL, { method: 'POST', headers: { 'stripe-signature': header }, body: `${payload}\n` });

    expect((await handleStripeWebhook(request, ctx.deps)).status).toBe(400);
  });
});
