'use client';

import { useState } from 'react';

/**
 * Local demo UI. It identifies the user with the demo headers that the server only
 * accepts when ALLOW_DEMO_AUTH=true. Replace it with your own pricing page and session.
 */
export function BillingPanel() {
  const [userId, setUserId] = useState('demo-user-1');
  const [email, setEmail] = useState('demo@example.com');
  const [output, setOutput] = useState('');

  async function call(path: string, method: 'GET' | 'POST', body?: unknown) {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-demo-user-id': userId, 'x-demo-user-email': email },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json()) as { url?: string };
    if (response.ok && data.url) {
      window.location.assign(data.url);
      return;
    }
    setOutput(`${response.status}\n${JSON.stringify(data, null, 2)}`);
  }

  return (
    <section>
      <p>
        <label>
          User id <input value={userId} onChange={(event) => setUserId(event.target.value)} />
        </label>{' '}
        <label>
          Email <input value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
      </p>
      <p>
        <button onClick={() => call('/api/checkout', 'POST', { plan: 'monthly' })}>Subscribe (monthly)</button>{' '}
        <button onClick={() => call('/api/checkout', 'POST', { plan: 'yearly' })}>Subscribe (yearly)</button>{' '}
        <button onClick={() => call('/api/portal', 'POST', {})}>Manage billing</button>{' '}
        <button onClick={() => call('/api/entitlement', 'GET')}>Check entitlement</button>
      </p>
      <pre>{output}</pre>
    </section>
  );
}
