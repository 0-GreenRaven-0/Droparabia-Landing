import type { APIRoute } from 'astro';

// Served at /robots.txt. The funnel pages are gated on a survey token and mean nothing
// out of context, so they're kept out of search; the pages worth ranking are not.
const SITE = 'https://join.droparabia.com';

const body = `User-agent: *
Allow: /
Disallow: /survey
Disallow: /choose-schedule
Disallow: /api/

Sitemap: ${SITE}/sitemap.xml
`;

export const GET: APIRoute = () =>
  new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
