export const prerender = false;

import type { APIRoute } from 'astro';
import { getGoogleAccessToken } from '../../lib/google-auth';

// The intake log for /get-to-know-you. Its own spreadsheet and its own service account,
// deliberately separate from the lead pipeline in subscribe.ts: one row per person,
// six plain columns, no stage sorting and no rows moving between sheets.
//
// Submitting question zero writes the row as "Didn't finish form"; finishing the survey
// updates that same row to "Finished form" and fills in the answers. The row is keyed on
// the email address, so a person who comes back and finishes later updates their row
// rather than adding a second one.

const HEADERS = ['Name', 'Email', 'Phone', 'Date', 'Answers', 'Status'];
const LAST_COL = 'F';
const EMAIL_COL_INDEX = 1; // B

type Answer = { q: string; a: string };
type Tab = { title: string; sheetId: number };

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function quote(title: string): string {
  return "'" + title.replace(/'/g, "''") + "'";
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// The same lesson as the lead sheets: a tab's gid is not its position, and a read that
// resolves to one tab must not be followed by a write addressed to another.
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

function parseAnswers(raw: unknown): Answer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = item as Partial<Answer> | null;
      return {
        q: typeof rec?.q === 'string' ? rec.q.replace(/\s+/g, ' ').trim() : '',
        a: typeof rec?.a === 'string' ? rec.a.replace(/\s+/g, ' ').trim() : '',
      };
    })
    .filter((item) => item.q && item.a)
    .slice(0, 20);
}

// One cell, one numbered line per question. Plain text rather than a dropdown so the
// column can be read, searched and exported without opening anything.
function formatAnswers(items: Answer[]): string {
  return items.map((item, i) => `${i + 1}. ${item.q}\n→ ${item.a}`).join('\n\n');
}

async function readColumn(spreadsheetId: string, tab: Tab, token: string): Promise<string[][]> {
  const range = encodeURIComponent(`${quote(tab.title)}!A:${LAST_COL}`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const data = await res.json() as { values?: string[][] };
  return data.values ?? [];
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const sheetId = import.meta.env.GOOGLE_SHEET_GET_TO_KNOW_YOU;
    // Its own account. Falls back to the main one so a missing variable degrades to
    // "writes with the other key" rather than to silence.
    const creds = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON_GET_TO_KNOW_YOU
               || import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!sheetId || !creds) return json({ success: false, error: 'Intake sheet not configured' }, 500);

    const body = await request.json() as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    if (!email) return json({ success: false, error: 'Missing email' }, 400);

    const name    = typeof body.name === 'string' ? body.name.trim() : '';
    const phone   = typeof body.phone === 'string' ? body.phone.trim() : '';
    const answers = parseAnswers(body.answers);
    const finished = body.status === 'finished';
    const status  = finished ? 'Finished form' : "Didn't finish form";

    const token = await getGoogleAccessToken(creds);
    const tab = await resolveFirstTab(sheetId, token);
    // No tab means the metadata call failed — almost always the sheet not being shared
    // with this service account. Writing blind from here is what silently lost rows
    // before, so stop and say so instead.
    if (!tab) return json({ success: false, error: 'Intake sheet unreachable' }, 502);

    const rows = await readColumn(sheetId, tab, token);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Header row, written once on the first submission into an empty sheet.
    if (rows.length === 0) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/`
          + `${encodeURIComponent(`${quote(tab.title)}!A1:${LAST_COL}1`)}?valueInputOption=RAW`,
        { method: 'PUT', headers: auth, body: JSON.stringify({ values: [HEADERS] }) },
      );
    }

    // Their existing row, if they already submitted question zero. Row 1 is the header.
    let rowNumber: number | null = null;
    let previous: string[] = [];
    for (let i = rows.length - 1; i >= 1; i--) {
      if (normalizeEmail(rows[i]?.[EMAIL_COL_INDEX]) === email) {
        rowNumber = i + 1;
        previous = rows[i];
        break;
      }
    }

    const row = [
      name || previous[0] || '',
      // Column B keeps the address as it was typed; the match above is what normalises.
      typeof body.email === 'string' ? body.email.trim() : email,
      phone || previous[2] || '',
      // The date they first appeared, kept through the update so it reads as when they
      // arrived rather than when they finished.
      previous[3] || new Date().toLocaleDateString('en-GB'),
      answers.length > 0 ? formatAnswers(answers) : (previous[4] || ''),
      status,
    ];

    // RAW, so nothing in a typed answer is reinterpreted as a formula or a date.
    const range = rowNumber
      ? `${quote(tab.title)}!A${rowNumber}:${LAST_COL}${rowNumber}`
      : `${quote(tab.title)}!A:${LAST_COL}`;

    const res = rowNumber
      ? await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
          { method: 'PUT', headers: auth, body: JSON.stringify({ values: [row] }) },
        )
      : await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append`
            + '?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
          { method: 'POST', headers: auth, body: JSON.stringify({ values: [row] }) },
        );

    if (!res.ok) return json({ success: false, error: `Sheets ${res.status}` }, 502);
    return json({ success: true }, 200);

  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};
