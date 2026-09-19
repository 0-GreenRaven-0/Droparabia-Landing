export const prerender = false;

import type { APIRoute } from 'astro';
import { getGoogleAccessToken } from '../../lib/google-auth';

// Weekly call capacity shown on the homepage ("N spots are available this week").
// The week runs Monday 12:00 AM to Sunday 11:59 PM, Beirut time; every row on the
// booked sheet dated inside the current week takes one spot.
const WEEKLY_SPOTS = 17;
const TIME_ZONE = 'Asia/Beirut';

// Each isolate keeps the last answer for a minute, so a traffic spike doesn't turn
// into one Sheets API read per page view.
const CACHE_MS = 60_000;
let cached: { at: number; body: SpotsResponse } | null = null;

type SpotsResponse = { total: number; booked: number; remaining: number; weekStart: string };

// Today's calendar date in Beirut as a UTC-midnight Date, so day arithmetic is DST-proof.
function beirutToday(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

function mondayOf(day: Date): Date {
  const daysSinceMonday = (day.getUTCDay() + 6) % 7; // Sunday (0) -> 6
  return new Date(day.getTime() - daysSinceMonday * 86_400_000);
}

// The booked sheet's Date column is written as dd/mm/yyyy (en-GB), but the sheet uses
// a US locale: when the day is 12 or less Google stores it as a real date with day and
// month swapped (12/09/2026, 12 Sept, becomes 9 Dec). Its underlying value is wrong,
// but the displayed text still reads exactly what was written, so the count parses
// the formatted text as dd/mm/yyyy rather than the stored date.
function parseSheetDate(cell: unknown): Date | null {
  if (typeof cell !== 'string') return null;
  const m = cell.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : null;
}

async function countBookedThisWeek(sheetId: string, credsJson: string, weekStart: Date): Promise<number> {
  const token = await getGoogleAccessToken(credsJson);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/D2:D`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}`);
  const data = await res.json() as { values?: unknown[][] };
  const weekEnd = weekStart.getTime() + 7 * 86_400_000;
  return (data.values || []).reduce<number>((n, row) => {
    const d = parseSheetDate(row[0]);
    return d && d.getTime() >= weekStart.getTime() && d.getTime() < weekEnd ? n + 1 : n;
  }, 0);
}

export const GET: APIRoute = async () => {
  const weekStart = mondayOf(beirutToday());
  const weekStartIso = weekStart.toISOString().slice(0, 10);

  if (cached && Date.now() - cached.at < CACHE_MS && cached.body.weekStart === weekStartIso) {
    return json(cached.body, 200);
  }

  const sheetId = import.meta.env.GOOGLE_SHEET_BOOKED;
  const credsJson = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sheetId || !credsJson) {
    return json({ error: 'Booked sheet not configured' }, 503);
  }

  try {
    const booked = await countBookedThisWeek(sheetId, credsJson, weekStart);
    const body: SpotsResponse = { total: WEEKLY_SPOTS, booked, remaining: Math.max(0, WEEKLY_SPOTS - booked), weekStart: weekStartIso };
    cached = { at: Date.now(), body };
    return json(body, 200);
  } catch (err) {
    return json({ error: String(err) }, 502);
  }
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
