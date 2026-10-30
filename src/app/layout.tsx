import type { ReactNode } from 'react';

export const metadata = {
  title: 'Billing starter',
  description: 'Stripe Checkout, Billing Portal and webhooks on the Next.js App Router.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '3rem auto', padding: '0 1rem' }}>
        {children}
      </body>
    </html>
  );
}
