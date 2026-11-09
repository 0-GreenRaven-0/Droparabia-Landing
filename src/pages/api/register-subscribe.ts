export const prerender = false;

import type { APIRoute } from 'astro';

const SUBSCRIPTION_LABELS: Record<string, string> = {
  '12_months': '12 Months',
  '6_months': '6 Months',
};

function getListId(subscriptionType: string): number | null {
  switch (subscriptionType) {
    case '6_months': return Number(import.meta.env.BREVO_LIST_6_MONTHS) || null;
    case '12_months': return Number(import.meta.env.BREVO_LIST_12_MONTHS) || null;
    default: return null;
  }
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
    const subscriptionType = typeof body.subscriptionType === 'string' ? body.subscriptionType.trim() : '';

    if (!firstName || !lastName || !email || !subscriptionType) {
      return json({ success: false, error: 'Missing required fields' }, 400);
    }
    if (!SUBSCRIPTION_LABELS[subscriptionType]) {
      return json({ success: false, error: 'Invalid subscription type' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, error: 'Invalid email address' }, 400);
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
        SUBSCRIPTION_TYPE: SUBSCRIPTION_LABELS[subscriptionType],
      },
      updateEnabled: true,
    };
    if (listId) brevoBody.listIds = [listId];

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(brevoBody),
    });

    if (res.status !== 201 && res.status !== 204) {
      const errBody = await res.text();
      return json({ success: false, error: errBody }, res.status);
    }

    return json({ success: true }, 200);
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
};
