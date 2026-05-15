export const prerender = false;

import type { APIRoute } from 'astro';

function getListId(list: string): number | null {
  switch (list) {
    case 'vsl':               return Number(import.meta.env.BREVO_LIST_VSL_SUBSCRIBED)    || null;
    case 'survey':            return Number(import.meta.env.BREVO_LIST_DIDNT_FINISH_SURVEY) || null;
    case 'qualified_no_book': return Number(import.meta.env.BREVO_LIST_QUALIFIED_NO_BOOK) || null;
    case 'unqualified':       return Number(import.meta.env.BREVO_LIST_UNQUALIFIED)        || null;
    case 'booked':            return Number(import.meta.env.BREVO_LIST_BOOKED)             || null;
    default:                  return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { name, email, phone, list } = body;

    if (!email || !list) {
      return json({ success: false, error: 'Missing email or list' }, 400);
    }

    const listId = getListId(list);
    if (!listId) {
      return json({ success: false, error: `Unknown or unconfigured list: ${list}` }, 400);
    }

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': import.meta.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        email,
        attributes: {
          FIRSTNAME: name || '',
          SMS: phone ? (phone.startsWith('+') ? phone : '+961' + phone) : '',
        },
        listIds: [listId],
        updateEnabled: true,
      }),
    });

    if (res.status === 201 || res.status === 204) {
      return json({ success: true }, 200);
    }

    const errBody = await res.text();
    return json({ success: false, error: errBody }, res.status);

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
