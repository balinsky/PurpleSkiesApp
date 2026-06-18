// Maps known Supabase/PostgREST error codes to user-friendly messages.
const CODE_MESSAGES: Record<string, string> = {
  '23505': 'That record already exists.',
  '23503': 'This item is referenced by other data and cannot be removed.',
  '42501': 'You don\'t have permission to do that.',
  'PGRST301': 'Your session has expired — please sign in again.',
  'PGRST116': 'Record not found.',
};

// Use for all Supabase database operation errors.
// Logs the original error to the console and returns a safe user-facing string.
export function friendlyError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e && typeof e === 'object') {
    const code = (e as any).code as string | undefined;
    if (code && CODE_MESSAGES[code]) { console.error(e); return CODE_MESSAGES[code]; }
  }
  console.error(e);
  return fallback;
}

// Supabase Auth messages are generally user-friendly; pass through safe patterns
// and fall back to a generic message for anything technical.
const SAFE_AUTH_PATTERNS = [
  /invalid login credentials/i,
  /email not confirmed/i,
  /user already registered/i,
  /password.*characters/i,
  /invalid email/i,
  /already registered/i,
  /signup.*disabled/i,
  /email.*already in use/i,
  /weak password/i,
];

export function friendlyAuthError(e: unknown, fallback = 'An unexpected error occurred. Please try again.'): string {
  if (e && typeof e === 'object') {
    const msg = (e as any).message as string | undefined;
    if (msg && SAFE_AUTH_PATTERNS.some(p => p.test(msg))) return msg;
  }
  console.error(e);
  return fallback;
}
