import { BillingPanel } from './billing-panel';

const MESSAGES: Record<string, string> = {
  success: 'Checkout finished. Access is granted when Stripe confirms the subscription by webhook, which can take a moment: use "Check entitlement".',
  cancelled: 'Checkout was cancelled. Nothing was charged.',
};

export default async function Home({ searchParams }: { searchParams: Promise<{ checkout?: string | string[] }> }) {
  const { checkout } = await searchParams;
  // The query string is user input: only look up keys we defined, never inherited ones like "constructor".
  const message = typeof checkout === 'string' && Object.hasOwn(MESSAGES, checkout) ? MESSAGES[checkout] : undefined;

  return (
    <main>
      <h1>Billing starter</h1>
      {message ? <p role="status">{message}</p> : null}
      <BillingPanel />
    </main>
  );
}
