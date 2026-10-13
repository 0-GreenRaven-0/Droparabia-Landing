export const prerender = false;

// Scratch endpoint for /test. Completely separate from /api/subscribe: no sheets, no
// traffic source, no Meta fields, no list routing, no dedupe, no validation beyond what
// Brevo itself enforces. It adds a contact to one hardcoded list and nothing else.
//
// Local only. import.meta.env.DEV is replaced with a literal false in the production
// build, so on the deployed site this route answers 404 and never reaches Brevo.

const TEST_LIST_ID = 16;

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST = async ({ request }: { request: Request }) => {
  if (!import.meta.env.DEV) return json({ success: false, error: 'Not available' }, 404);

  try {
    const body = await request.json() as { name?: string; email?: string; phone?: string };
    const email = (body.email || '').trim();
    if (!email) return json({ success: false, error: 'Email required' }, 400);

    const name = (body.name || '').trim();
    const space = name.indexOf(' ');

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': import.meta.env.BREVO_API_KEY },
      body: JSON.stringify({
        email,
        attributes: {
          FIRSTNAME: space === -1 ? name : name.slice(0, space),
          LASTNAME: space === -1 ? '' : name.slice(space + 1),
          SMS: (body.phone || '').trim(),
        },
        listIds: [TEST_LIST_ID],
        updateEnabled: true,
      }),
    });

    const text = await res.text();
    // 201 created, 204 updated. Anything else is handed back as-is so the page can show
    // exactly what Brevo said rather than a generic failure.
    if (res.status !== 201 && res.status !== 204) {
      return json({ success: false, status: res.status, error: text || 'Brevo rejected it' }, 200);
    }
    return json({ success: true, status: res.status, listId: TEST_LIST_ID }, 200);
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};
