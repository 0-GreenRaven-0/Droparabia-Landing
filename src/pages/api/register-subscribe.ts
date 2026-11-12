export const prerender = false;

import type { APIRoute } from 'astro';
import { getGoogleAccessToken } from '../../lib/google-auth';

const SUBSCRIPTION_LABELS: Record<string, string> = {
  '12_months': '12 Months',
  '6_months': '6 Months',
};

const OFFER_LABELS: Record<string, string> = {
  '12_months': '12M',
  '6_months': '6M',
};

// The onboarded-leads log for /register. Its own spreadsheet and its own service
// account (GOOGLE_SERVICE_ACCOUNT_JSON_NEW), separate from the other sheets on this
// site — no fallback to the main service account, since this one is scoped to this
// route only.
const LEAD_HEADERS = ['First Name', 'Last Name', 'Email', 'Phone', 'Date', 'Offer'];
const LEAD_LAST_COL = 'F';

type Tab = { title: string; sheetId: number };

function quote(title: string): string {
  return "'" + title.replace(/'/g, "''") + "'";
}

// A tab's gid is not its position — read the first tab by index and write back to
// that exact title, never a hardcoded "Sheet1" that might not be the first tab.
async function resolveFirstTab(spreadsheetId: string, token: string): Promise<Tab | null> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title,index)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const data = await res.json() as { sheets?: { properties?: { sheetId?: number; title?: string; index?: number } }[] };
  const props = (data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is { sheetId: number; title: string; index: number } =>
      !!p && typeof p.sheetId === 'number' && typeof p.title === 'string' && typeof p.index === 'number')
    .sort((a, b) => a.index - b.index);
  const first = props[0];
  return first ? { title: first.title, sheetId: first.sheetId } : null;
}

async function logLead(firstName: string, lastName: string, email: string, phone: string, subscriptionType: string): Promise<void> {
  const sheetId = import.meta.env.GOOGLE_SHEET_REGISTER;
  const creds = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON_NEW;
  if (!sheetId || !creds) return;

  const token = await getGoogleAccessToken(creds);
  const tab = await resolveFirstTab(sheetId, token);
  if (!tab) return;

  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const range = encodeURIComponent(`${quote(tab.title)}!A:${LEAD_LAST_COL}`);

  const existing = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const existingRows = existing.ok ? ((await existing.json() as { values?: unknown[][] }).values ?? []) : [];

  if (existingRows.length === 0) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/`
        + `${encodeURIComponent(`${quote(tab.title)}!A1:${LEAD_LAST_COL}1`)}?valueInputOption=RAW`,
      { method: 'PUT', headers: auth, body: JSON.stringify({ values: [LEAD_HEADERS] }) },
    );
  }

  const row = [firstName, lastName, email, phone, new Date().toLocaleDateString('en-GB'), OFFER_LABELS[subscriptionType] ?? subscriptionType];
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append`
      + '?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    { method: 'POST', headers: auth, body: JSON.stringify({ values: [row] }) },
  );
}

// Plain list IDs, not secrets — committed directly so this route works without any
// Cloudflare env var setup. BREVO_API_KEY (the actual credential) still comes from
// the environment, same as every other route on this site.
const LIST_IDS: Record<string, number> = {
  '6_months': 26,
  '12_months': 27,
};

function getListId(subscriptionType: string): number | null {
  return LIST_IDS[subscriptionType] ?? null;
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
    const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const subscriptionType = typeof body.subscriptionType === 'string' ? body.subscriptionType.trim() : '';

    if (!firstName || !lastName || !email || !phone || !subscriptionType) {
      return json({ success: false, error: 'Missing required fields' }, 400);
    }
    if (!SUBSCRIPTION_LABELS[subscriptionType]) {
      return json({ success: false, error: 'Invalid subscription type' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, error: 'Invalid email address' }, 400);
    }
    // E.164: a leading + then 7–15 digits — the shape Brevo's SMS attribute expects.
    // The client already builds the number in this form; this just guards against a
    // direct API call bypassing that.
    if (!/^\+\d{7,15}$/.test(phone)) {
      return json({ success: false, error: 'Invalid phone number' }, 400);
    }

    const apiKey = import.meta.env.BREVO_API_KEY;
    if (!apiKey) {
      return json({ success: false, error: 'Server is not configured for subscriptions' }, 500);
    }

    const listId = getListId(subscriptionType);

    const brevoBody: Record<string, unknown> = {
      email,
      attributes: {
        FIRSTNAME: firstName,
        LASTNAME: lastName,
        SMS: phone,
        SUBSCRIPTION_TYPE: SUBSCRIPTION_LABELS[subscriptionType],
      },
      updateEnabled: true,
    };
    if (listId) brevoBody.listIds = [listId];

    function postContact(payload: Record<string, unknown>) {
      return fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify(payload),
      });
    }

    let res = await postContact(brevoBody);

    // updateEnabled resolves a duplicate EMAIL, but not a duplicate SMS — if that
    // number is already attached to a different contact, Brevo hard-rejects the whole
    // request. Retry once without the phone so the registration still goes through;
    // the number simply stays on whichever contact already owns it.
    if (res.status === 400) {
      const errText = await res.clone().text();
      let isDuplicateSms = false;
      try {
        const parsed = JSON.parse(errText) as { code?: string; metadata?: { duplicate_identifiers?: string[] } };
        isDuplicateSms =
          parsed.code === 'duplicate_parameter' &&
          Array.isArray(parsed.metadata?.duplicate_identifiers) &&
          parsed.metadata.duplicate_identifiers.includes('SMS');
      } catch { /* non-JSON error body — fall through and report it as-is below */ }

      if (isDuplicateSms) {
        const attributes = { ...(brevoBody.attributes as Record<string, unknown>) };
        delete attributes.SMS;
        res = await postContact({ ...brevoBody, attributes });
      }
    }

    if (res.status !== 201 && res.status !== 204) {
      const errBody = await res.text();
      return json({ success: false, error: errBody }, res.status);
    }

    // Best-effort lead log — Brevo is the system of record for the subscription
    // itself, so a Sheets hiccup here must not turn a successful registration into
    // an error response.
    try {
      await logLead(firstName, lastName, email, phone, subscriptionType);
    } catch (err) {
      console.error('register-subscribe: failed to log lead to sheet', err);
    }

    return json({ success: true }, 200);
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};
