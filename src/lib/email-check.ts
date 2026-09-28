// Email quality checks that run before anything is written. The bias throughout is to
// accept: a rejected real lead costs more than a bounced fake one, so every uncertain
// case (DNS hiccup, unknown domain, odd but plausible address) passes.

export type RejectReason = 'honeypot' | 'syntax' | 'disposable' | 'no-mx';

export type EmailCheck =
  | { ok: true }
  | { ok: false; reason: RejectReason; message: string };

// Wording the pages already use: plain, second person, and never the word "invalid".
const MESSAGES: Record<Exclude<RejectReason, 'honeypot'>, string> = {
  syntax: "That address doesn't look right, can you check it?",
  disposable: "That email provider won't receive our emails, can you use another address?",
  'no-mx': "That email provider won't receive our emails, can you use another address?",
};

// Trim and lowercase, and nothing else. Dots and +tags are deliberately left alone:
// ali.hassan@gmail.com and alihassan@gmail.com stay separate records, because that is
// what Brevo and the sheet hold. Matches the Email Normalized column exactly.
export function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

// Permissive on purpose, and Unicode-safe: something, an @, a domain with a dot and a
// sensible tail. A strict RFC pattern rejects real addresses, which is the expensive
// mistake here. No character class is restricted to ASCII.
const SYNTAX = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.\d]{2,}$/u;

export function hasValidSyntax(email: string): boolean {
  if (email.length < 6 || email.length > 254) return false;
  if (email.includes('..')) return false;
  return SYNTAX.test(email);
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

// Well-known throwaway providers only. Deliberately short and hand-kept rather than a
// package: the long community lists sweep up small business and custom domains, and a
// false positive here silently loses a real lead.
// To add: one lowercase domain per line, providers only — never a domain that a real
// business could plausibly be using.
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com', 'tempmail.com', 'temp-mail.org', 'guerrillamail.com', 'guerrillamail.net',
  'sharklasers.com', 'grr.la', 'spam4.me', '10minutemail.com', '10minutemail.net',
  'throwawaymail.com', 'yopmail.com', 'yopmail.fr', 'maildrop.cc', 'dispostable.com',
  'trashmail.com', 'trashmail.de', 'mailnesia.com', 'mytemp.email', 'fakeinbox.com',
  'getairmail.com', 'getnada.com', 'nada.email', 'inboxbear.com', 'emailondeck.com',
  'mohmal.com', 'tempinbox.com', 'tempmailo.com', 'temp-mail.io', 'moakt.com',
  'mailcatch.com', 'spamgourmet.com', 'jetable.org', 'mintemail.com', 'incognitomail.com',
  'anonbox.net', 'burnermail.io', 'mailsac.com', 'harakirimail.com', 'deadaddress.com',
  'tempail.com', 'tmail.ws', 'discard.email', 'spambog.com', 'mailexpire.com',
  'trbvm.com', 'byom.de', 'e4ward.com', 'mailimate.com', 'tempr.email',
  'dropmail.me', 'minuteinbox.com', 'luxusmail.org', 'vomoto.com', 'einrot.com',
  'mailbox52.ga', 'fakemail.net', 'tempsky.com', 'emailfake.com', 'throwaway.email',
]);

export function isDisposable(email: string): boolean {
  return DISPOSABLE_DOMAINS.has(domainOf(email));
}

// Resolved over DNS-over-HTTPS, not node:dns — Cloudflare Workers does not implement
// node:dns, even with nodejs_compat.
const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 1200;

// One isolate handles many requests, so the same domain is only looked up once per
// isolate. Bounded so a flood of junk domains can't grow it without limit.
const mxCache = new Map<string, boolean>();
const MX_CACHE_MAX = 500;

/**
 * True when the domain can receive mail, and ALSO true whenever the lookup itself
 * fails — a DNS hiccup, a timeout or a bad response must never block a real lead.
 * Only a clean, successful answer with no usable records returns false.
 */
export async function hasMailExchanger(domain: string): Promise<boolean> {
  if (!domain) return true;
  const cached = mxCache.get(domain);
  if (cached !== undefined) return cached;

  let result = true; // fail open
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
    try {
      const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=MX`, {
        headers: { accept: 'application/dns-json' },
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json() as { Status?: number; Answer?: { type?: number; data?: string }[] };
        // Status 0 is NOERROR and 3 is NXDOMAIN; anything else is a server-side problem
        // we should not read as "this address is bad".
        if (data.Status === 3) {
          result = false;
        } else if (data.Status === 0) {
          const mx = (data.Answer ?? []).filter((a) => a.type === 15 && a.data);
          // A single "." target is the explicit null MX of RFC 7505: no mail accepted.
          result = mx.length > 0 && !mx.every((a) => (a.data ?? '').trim().endsWith(' .'));
          // Some domains take mail on the A record alone, with no MX published.
          if (!result && mx.length === 0) {
            const aRes = await fetch(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=A`, {
              headers: { accept: 'application/dns-json' },
              signal: controller.signal,
            });
            if (aRes.ok) {
              const aData = await aRes.json() as { Answer?: { type?: number }[] };
              result = (aData.Answer ?? []).some((a) => a.type === 1);
            } else {
              result = true;
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    result = true; // timeout, abort, network error — accept
  }

  if (mxCache.size >= MX_CACHE_MAX) mxCache.clear();
  mxCache.set(domain, result);
  return result;
}

/**
 * Runs every check in order of cost. `enforce` false performs the same checks and
 * returns the same reason, but the caller treats it as advisory: used for the lists a
 * visitor has already moved past, where dropping the row is worse than accepting a
 * questionable address.
 */
export async function checkEmail(rawEmail: unknown): Promise<EmailCheck> {
  const email = normalizeEmail(rawEmail);

  if (!hasValidSyntax(email)) return { ok: false, reason: 'syntax', message: MESSAGES.syntax };
  if (isDisposable(email)) return { ok: false, reason: 'disposable', message: MESSAGES.disposable };
  if (!(await hasMailExchanger(domainOf(email)))) {
    return { ok: false, reason: 'no-mx', message: MESSAGES['no-mx'] };
  }
  return { ok: true };
}

// Bots fill every field they can see. Either being non-empty is enough: one is Brevo's
// own public field name, which a bot trained on Brevo forms may know to skip, so the
// second is there to catch those.
export function honeypotTripped(body: Record<string, unknown>): boolean {
  const fields = ['email_address_check', 'company_website'];
  return fields.some((f) => typeof body[f] === 'string' && body[f].trim() !== '');
}

// Domain only, never the address itself.
export function logRejection(reason: RejectReason, list: unknown, email: string): void {
  const domain = reason === 'honeypot' ? '-' : domainOf(normalizeEmail(email)) || '-';
  console.warn(`[email-reject] reason=${reason} list=${typeof list === 'string' ? list : '-'} domain=${domain}`);
}
