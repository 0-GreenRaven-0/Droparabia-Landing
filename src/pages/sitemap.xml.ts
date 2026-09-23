import type { APIRoute } from 'astro';

// Served at /sitemap.xml, and pointed to from robots.txt. Only the pages worth ranking:
// the gated funnel pages (/survey, /choose-schedule) are excluded to match robots.txt,
// and /privacy-policy is left out because it carries a noindex tag.
const SITE = 'https://join.droparabia.com';
const PAGES = ['/', '/the-ultimate-copy-program', '/testimonials', '/review-us', '/terms'];

export const GET: APIRoute = () => {
  const urls = PAGES.map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
