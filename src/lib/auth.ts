export interface AuthUser {
  id: string;
  email?: string;
}

/** Resolves the signed-in user for a request, or null when there is none. */
export type AuthResolver = (request: Request) => Promise<AuthUser | null>;

/** Default: nobody is signed in. Replace with your session lookup (see README, "Authentication"). */
export const denyAll: AuthResolver = async () => null;

/**
 * Trusts `x-demo-user-id` / `x-demo-user-email` request headers. Anyone can send
 * those, so it is only wired in when ALLOW_DEMO_AUTH=true and must never be used
 * outside local development.
 */
export const demoHeaderAuth: AuthResolver = async (request) => {
  const id = request.headers.get('x-demo-user-id')?.trim();
  if (!id) return null;
  const email = request.headers.get('x-demo-user-email')?.trim();
  return email ? { id, email } : { id };
};
