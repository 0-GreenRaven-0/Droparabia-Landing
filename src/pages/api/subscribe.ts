export const prerender = false;

import type { APIRoute } from 'astro';
import { getGoogleAccessToken } from '../../lib/google-auth';

// ── Brevo ────────────────────────────────────────────────────────────────────

function getListId(list: string): number | null {
  switch (list) {
    case 'vsl':               return Number(import.meta.env.BREVO_LIST_VSL_SUBSCRIBED)      || null;
    case 'survey':            return Number(import.meta.env.BREVO_LIST_DIDNT_FINISH_SURVEY)  || null;
    case 'qualified_no_book': return Number(import.meta.env.BREVO_LIST_QUALIFIED_NO_BOOK)    || null;
    case 'unqualified':       return Number(import.meta.env.BREVO_LIST_UNQUALIFIED)          || null;
    case 'booked':            return Number(import.meta.env.BREVO_LIST_BOOKED)               || null;
    default:                  return null;
  }
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

function getSheetId(list: string): string | null {
  switch (list) {
    case 'vsl':               return import.meta.env.GOOGLE_SHEET_VSL               || null;
    case 'survey':            return import.meta.env.GOOGLE_SHEET_SURVEY             || null;
    case 'qualified_no_book': return import.meta.env.GOOGLE_SHEET_QUALIFIED_NO_BOOK  || null;
    case 'unqualified':       return import.meta.env.GOOGLE_SHEET_UNQUALIFIED        || null;
    case 'booked':            return import.meta.env.GOOGLE_SHEET_BOOKED             || null;
    case 'went_to_buy_course': return import.meta.env.GOOGLE_SHEET_WENT_TO_BUY_COURSE || null;
    default:                  return null;
  }
}

// Lists that exist only as a sheet. There's no Brevo list to add them to, so on Brevo
// they're just unlinked from every other list (e.g. dropped from unqualified).
const SHEET_ONLY_LISTS = new Set(['went_to_buy_course']);

// Lists logged to their sheet only, with Brevo left out entirely: the contact isn't
// added to or removed from any Brevo list, so they keep whatever lists they're on.
// "survey" is everyone who opened the survey and hasn't finished it yet.
const NO_BREVO_LISTS = new Set(['survey']);

function getUnlinkListIds(list: string): number[] {
  const all: Record<string, number> = {
    vsl:               Number(import.meta.env.BREVO_LIST_VSL_SUBSCRIBED)      || 0,
    survey:            Number(import.meta.env.BREVO_LIST_DIDNT_FINISH_SURVEY)  || 0,
    qualified_no_book: Number(import.meta.env.BREVO_LIST_QUALIFIED_NO_BOOK)    || 0,
    unqualified:       Number(import.meta.env.BREVO_LIST_UNQUALIFIED)          || 0,
    booked:            Number(import.meta.env.BREVO_LIST_BOOKED)               || 0,
  };
  return Object.entries(all)
    .filter(([key, id]) => key !== list && id !== 0)
    .map(([, id]) => id);
}


// Strips formatting/country-code prefixes down to the bare national number,
// matching the client-side isValidLebanesePhone logic.
function normalizePhone(raw: string): string {
  let d = (raw || '').replace(/[\s\-()+.]/g, '');
  if (d.startsWith('00961')) d = d.slice(5);
  else if (d.startsWith('961') && d.length >= 10) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

function formatPhoneDisplay(digits: string): string {
  if (digits.length === 8) return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
  return digits;
}

// Numbers now arrive in full international form (+20 100 ...) from the country picker,
// but older callers still send a bare Lebanese national number. Returns what Brevo needs
// (E.164) and what goes on the sheet — Lebanese numbers keep their familiar grouping.
function parsePhone(raw: string): { e164: string; display: string } {
  const trimmed = (raw || '').trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return { e164: '', display: '' };
    if (digits.startsWith('961')) return { e164: `+${digits}`, display: formatPhoneDisplay(digits.slice(3)) };
    return { e164: `+${digits}`, display: `+${digits}` };
  }
  const national = normalizePhone(trimmed);
  return national ? { e164: `+961${national}`, display: formatPhoneDisplay(national) } : { e164: '', display: '' };
}

const SHEET_HEADERS = ['Name', 'Email', 'Phone', 'Date', 'Traffic Source', 'Campaign Name', 'Creative', 'Hook', 'Form Clicked', 'Headline', 'VSL Watched', 'VSL %', 'Survey Answers'];
const SURVEY_COL_INDEX = SHEET_HEADERS.indexOf('Survey Answers'); // 0-based, for batchUpdate ranges
// Ranges follow the header list so adding a column doesn't need three edits. A sheet
// still on the old, narrower header row is rewritten on the next append (see
// appendToSheet), leaving existing rows padded with blanks.
const LAST_COL = String.fromCharCode(64 + SHEET_HEADERS.length);

// ── Survey answers column ─────────────────────────────────────────────────────

type SurveyAnswer = { q: string; a: string };

// A guard, not a real constraint: the API accepts far longer list entries, and the
// longest question here (the effort one) lands around 250 characters.
const DROPDOWN_ITEM_MAX = 500;

function parseSurveyAnswers(raw: unknown): SurveyAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const rec = item as Partial<SurveyAnswer> | null;
      const q = typeof rec?.q === 'string' ? rec.q.replace(/\s+/g, ' ').trim() : '';
      const a = typeof rec?.a === 'string' ? rec.a.replace(/\s+/g, ' ').trim() : '';
      return { q, a };
    })
    .filter((item) => item.q && item.a)
    .slice(0, 20);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

// The cell holds a short label so the column stays readable at a glance; the label is
// also the first dropdown entry, which keeps the value valid and stops Sheets flagging
// it. Opening the dropdown lists every question with the answer they picked. The same
// text, unclipped and on separate lines, goes on the cell as a note for hovering.
function buildSurveyCell(items: SurveyAnswer[]) {
  const label = items.length === 1 ? 'View 1 answer' : `View ${items.length} answers`;
  const options = [label, ...items.map((item, i) => clip(`${i + 1}. ${item.q} → ${item.a}`, DROPDOWN_ITEM_MAX))];
  const note = items.map((item, i) => `${i + 1}. ${item.q}\n→ ${item.a}`).join('\n\n');
  return { label, options, note };
}

async function applySurveyDropdown(
  spreadsheetId: string, rowNumber: number, options: string[], note: string, token: string,
): Promise<void> {
  const range = {
    sheetId: 0,
    startRowIndex: rowNumber - 1,
    endRowIndex: rowNumber,
    startColumnIndex: SURVEY_COL_INDEX,
    endColumnIndex: SURVEY_COL_INDEX + 1,
  };
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          setDataValidation: {
            range,
            rule: {
              condition: { type: 'ONE_OF_LIST', values: options.map((value) => ({ userEnteredValue: value })) },
              showCustomUi: true,
              strict: true,
            },
          },
        },
        { repeatCell: { range, cell: { note }, fields: 'note' } },
      ],
    }),
  });
}

// Seconds → m:ss, for the watch-time column.
function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function buildTrafficSource(source: string, medium: string, referrer: string): string {
  const s = (source || '').toLowerCase().trim();
  const m = (medium || '').toLowerCase().trim();

  // UTM-based labels take priority
  if (s) {
    if ((s === 'ig' || s === 'instagram') && m === 'paid') return 'Instagram Paid Ad';
    if ((s === 'fb' || s === 'facebook')  && m === 'paid') return 'Facebook Paid Ad';
    if ((s === 'ig' || s === 'instagram'))                 return 'Instagram Organic';
    if (s === 'linkedin' || s === 'lnkd.in')              return 'LinkedIn';
    if (s === 'google' && m === 'organic')                 return 'Google Search';
    return [s, m].filter(Boolean).join(' / ');
  }

  // Referrer fallback
  if (referrer) {
    try {
      const host = new URL(referrer).hostname.replace('www.', '');
      if (host.includes('instagram.com'))                    return 'Instagram Organic';
      if (host.includes('linkedin.com') || host.includes('lnkd.in')) return 'LinkedIn';
      if (host.includes('facebook.com'))                     return 'Facebook Organic';
      if (host.includes('google.com'))                       return 'Google Search';
      if (host.includes('youtube.com'))                      return 'YouTube';
      return host;
    } catch { return referrer; }
  }

  return 'Direct Visit';
}

async function removeEmailFromSheet(spreadsheetId: string, email: string, token: string): Promise<void> {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const res  = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/B:B`, { headers: auth });
  const data = await res.json() as { values?: string[][] };
  if (!data.values) return;

  const rowsToDelete: number[] = [];
  data.values.forEach((row, i) => {
    if (i === 0) return; // skip header
    if (row[0]?.toLowerCase() === email.toLowerCase()) rowsToDelete.push(i);
  });
  if (rowsToDelete.length === 0) return;

  // Delete bottom-up so indices stay valid
  const requests = rowsToDelete.reverse().map(rowIndex => ({
    deleteDimension: {
      range: { sheetId: 0, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
    },
  }));

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ requests }),
  });
}

async function removeEmailFromAllSheets(email: string, token: string): Promise<void> {
  const ids = [
    import.meta.env.GOOGLE_SHEET_VSL,
    import.meta.env.GOOGLE_SHEET_SURVEY,
    import.meta.env.GOOGLE_SHEET_QUALIFIED_NO_BOOK,
    import.meta.env.GOOGLE_SHEET_UNQUALIFIED,
    import.meta.env.GOOGLE_SHEET_BOOKED,
    import.meta.env.GOOGLE_SHEET_WENT_TO_BUY_COURSE,
  ].filter(Boolean) as string[];
  await Promise.all(ids.map(id => removeEmailFromSheet(id, email, token)));
}

// Returns the 1-based row the values landed on, so the caller can decorate that cell.
async function appendToSheet(sheetId: string, row: string[], token: string): Promise<number | null> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Write headers if missing or outdated (column count changed)
  const check = await fetch(`${base}/A1:${LAST_COL}1`, { headers: auth });
  const checkData = await check.json() as { values?: string[][] };
  const existingHeaders = checkData.values?.[0] ?? [];
  if (existingHeaders[0] !== 'Name' || existingHeaders.length < SHEET_HEADERS.length) {
    await fetch(`${base}/A1:${LAST_COL}1?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
  }

  const res = await fetch(`${base}/A:${LAST_COL}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: [row] }),
  });

  // updatedRange reads like "Sheet1!A42:M42".
  const data = await res.json().catch(() => null) as { updates?: { updatedRange?: string } } | null;
  const match = data?.updates?.updatedRange?.match(/![A-Z]+(\d+)/);
  return match ? Number(match[1]) : null;
}

async function incrementBookingCount(sheetId: string, token: string): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const today = new Date().toLocaleDateString('en-GB');

  // Ensure headers
  const headerRes = await fetch(`${base}/A1`, { headers: auth });
  const headerData = await headerRes.json() as { values?: string[][] };
  if (!headerData.values || headerData.values[0]?.[0] !== 'Date') {
    await fetch(`${base}/A1:B1?valueInputOption=USER_ENTERED`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ values: [['Date', 'Number of Bookings']] }),
    });
  }

  // Read all dates in column A
  const colRes = await fetch(`${base}/A:B`, { headers: auth });
  const colData = await colRes.json() as { values?: string[][] };
  const rows = colData.values || [];

  // Find row index for today (1-based, skip header)
  let todayRowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === today) { todayRowIndex = i + 1; break; }
  }

  if (todayRowIndex > 0) {
    // Increment existing count
    const current = parseInt(rows[todayRowIndex - 1][1] || '0', 10);
    await fetch(`${base}/A${todayRowIndex}:B${todayRowIndex}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ values: [[today, current + 1]] }),
    });
  } else {
    // Append new row for today
    await fetch(`${base}/A:B:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ values: [[today, 1]] }),
    });
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { name, email, phone, list, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, cta_popup, prev_email,
            headline, vsl_watched_seconds, vsl_furthest_seconds, vsl_duration_seconds } = body;

    // Visitors who reach the sales page without going through the VSL/survey have no
    // contact info. Their buy click is still logged on the sheet as "Anonymous" with
    // its traffic source; there's no email, so Brevo and the de-dupe pass are skipped.
    if (body.anonymous === true && SHEET_ONLY_LISTS.has(list)) {
      const sheetId   = getSheetId(list);
      const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      if (!sheetId) {
        return json({ success: false, error: `Unknown or unconfigured list: ${list}` }, 400);
      }
      if (credsJson) {
        const isPaid = (utm_medium || '').toLowerCase().trim() === 'paid';
        const row = [
          'Anonymous', '', '', new Date().toLocaleDateString('en-GB'),
          buildTrafficSource(utm_source || '', utm_medium || '', referrer || ''),
          isPaid ? (utm_campaign || '') : '',
          isPaid ? (utm_content  || '') : '',
          isPaid ? (utm_term     || '') : '',
          '', typeof headline === 'string' ? headline : '', '', '', '',
        ];
        await (async () => {
          const token = await getGoogleAccessToken(credsJson);
          await appendToSheet(sheetId, row, token);
        })().catch(() => {});
      }
      return json({ success: true }, 200);
    }

    if (!email || !list) {
      return json({ success: false, error: 'Missing email or list' }, 400);
    }

    const listId = getListId(list);
    const skipBrevo = NO_BREVO_LISTS.has(list);
    const sheetOnly = (SHEET_ONLY_LISTS.has(list) || skipBrevo) && !!getSheetId(list);
    if (!listId && !sheetOnly) {
      return json({ success: false, error: `Unknown or unconfigured list: ${list}` }, 400);
    }

    // An address they were previously filed under (they booked with a different one).
    // Everything below keys off the email, so without this the old list membership and
    // the old sheet row would both be left behind.
    const previousEmail = typeof prev_email === 'string' ? prev_email.trim() : '';
    const hasPreviousEmail = !!previousEmail && previousEmail.toLowerCase() !== String(email).toLowerCase();

    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';
    const parsedPhone = parsePhone(phone || '');

    // ── Brevo ──
    if (!skipBrevo) {
      const unlinkListIds = getUnlinkListIds(list);
      const brevoBody: Record<string, unknown> = {
        email,
        attributes: {
          FIRSTNAME: firstName,
          LASTNAME:  lastName,
          SMS: parsedPhone.e164,
        },
        updateEnabled: true,
      };
      if (listId) brevoBody.listIds = [listId];
      if (unlinkListIds.length > 0) brevoBody.unlinkListIds = unlinkListIds;

      function postContact(body: Record<string, unknown>) {
        return fetch('https://api.brevo.com/v3/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': import.meta.env.BREVO_API_KEY },
          body: JSON.stringify(body),
        });
      }

      let res = await postContact(brevoBody);

      // `updateEnabled` resolves a duplicate EMAIL, but not a duplicate SMS: if that phone
      // number is already attached to a different contact, Brevo hard-rejects with 400
      // duplicate_parameter and the signup is lost entirely. Retry without the phone so the
      // lead still lands on the right list with their email and name — the phone simply
      // stays on whichever contact already owns it.
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

      // Detach the old contact from every list it was on. '' matches no list key, so
      // getUnlinkListIds returns all of them.
      if (hasPreviousEmail) {
        const allListIds = getUnlinkListIds('');
        if (allListIds.length > 0) {
          await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(previousEmail)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'api-key': import.meta.env.BREVO_API_KEY },
            body: JSON.stringify({ unlinkListIds: allListIds }),
          }).catch(() => {});
        }
      }
    }

    // ── Google Sheets (fire after Brevo succeeds, silent fail) ──
    const sheetId   = getSheetId(list);
    const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (sheetId && credsJson) {
      const displayPhone = parsedPhone.display;
      const date         = new Date().toLocaleDateString('en-GB');
      const isPaid        = (utm_medium || '').toLowerCase().trim() === 'paid';
      const trafficSource = buildTrafficSource(utm_source || '', utm_medium || '', referrer || '');
      const campaignName  = isPaid ? (utm_campaign || '') : '';
      const creative      = isPaid ? (utm_content  || '') : '';
      const hook          = isPaid ? (utm_term     || '') : '';

      // Which A/B/C hero hook was on screen when they signed up.
      const headlineVariant = typeof headline === 'string' ? headline : '';

      // Watch time is only known once they've actually played the VSL, so it lands on
      // the survey/booked rows and stays blank on the initial vsl-list row. "Watched"
      // is time actually played (re-watching the same stretch doesn't double-count,
      // skipping ahead doesn't inflate it); the percentage is the furthest point they
      // reached, which is what "how far did they get" usually means.
      const watchedSecs  = Number(vsl_watched_seconds)  || 0;
      const furthestSecs = Number(vsl_furthest_seconds) || 0;
      const durationSecs = Number(vsl_duration_seconds) || 0;
      const vslWatched = watchedSecs > 0 ? formatClock(watchedSecs) : '';
      const vslPercent = durationSecs > 0 && furthestSecs > 0
        ? Math.min(100, Math.round((furthestSecs / durationSecs) * 100)) + '%'
        : '';
      // What they picked on the survey, one dropdown entry per question.
      const surveyAnswers = parseSurveyAnswers(body.survey_answers);
      const surveyCell = surveyAnswers.length > 0 ? buildSurveyCell(surveyAnswers) : null;

      await (async () => {
        const token = await getGoogleAccessToken(credsJson);
        await removeEmailFromAllSheets(email, token);
        if (hasPreviousEmail) await removeEmailFromAllSheets(previousEmail, token);
        const rowNumber = await appendToSheet(sheetId, [name || '', email, displayPhone, date, trafficSource, campaignName, creative, hook, cta_popup || '', headlineVariant, vslWatched, vslPercent, surveyCell ? surveyCell.label : ''], token);
        if (surveyCell && rowNumber) {
          await applySurveyDropdown(sheetId, rowNumber, surveyCell.options, surveyCell.note, token);
        }

        const landingBookingsSheetId = import.meta.env.GOOGLE_SHEET_LANDING_PAGE_BOOKINGS;
        if (list === 'booked' && landingBookingsSheetId) {
          await incrementBookingCount(landingBookingsSheetId, token);
        }
      })().catch(() => {});
    }

    return json({ success: true }, 200);

  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
