# GetRecommendedByAi

AI SEO / GEO SaaS MVP. The first version has no user center and no payments. It scans a URL, discovers citation gaps, and generates user-facing optimization recommendations.

## Stack

- Next.js App Router
- Firecrawl API for site discovery and page extraction
- OpenAI structured outputs for GEO analysis
- Supabase for scan records
- Vercel deployment

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Fill in `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
3. Run the Supabase SQL in `supabase/schema.sql`.
4. Install and start:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deployment

This app needs a running Next.js server because scans call the `/api/analyze` API route. GitHub can store the source code, but GitHub Pages is static hosting and cannot run this API route.

Deploy the app to Vercel or another Next.js/Node hosting provider, then add these environment variables in the hosting dashboard:

- `FIRECRAWL_API_KEY`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FIRECRAWL_MAP_LIMIT`
- `FIRECRAWL_MAP_TIMEOUT_MS`
- `FIRECRAWL_SCRAPE_TIMEOUT_MS`
- `SITE_FILE_TIMEOUT_MS`
- `SCAN_MAX_PAGES`
- `SCAN_READY_PAGES`

If the browser shows that the analysis API is not reachable, confirm that the deployed URL is not a static GitHub Pages site and that the environment variables are configured on the server.

## Environment variables

```bash
FIRECRAWL_API_KEY=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://sub2.de5.net/v1
OPENAI_MODEL=gpt-5.5
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
FIRECRAWL_MAP_LIMIT=12
FIRECRAWL_MAP_TIMEOUT_MS=10000
FIRECRAWL_SCRAPE_TIMEOUT_MS=20000
SITE_FILE_TIMEOUT_MS=2500
SCAN_MAX_PAGES=3
SCAN_READY_PAGES=2
```

Use the raw API key value only. Do not include shell prefixes such as `export OPENAI_API_KEY=...` or `$env:OPENAI_API_KEY=...` in `.env.local`.

`SUPABASE_SERVICE_ROLE_KEY` is only used in the server route. Do not expose it to the browser.

### Scan speed tuning

- `SCAN_MAX_PAGES` controls how many candidate URLs can be scraped.
- `SCAN_READY_PAGES` lets the report continue once enough useful pages have been extracted, instead of waiting for every slow page.
- `FIRECRAWL_MAP_TIMEOUT_MS` limits site discovery time before falling back to the submitted URL.
- `FIRECRAWL_SCRAPE_TIMEOUT_MS` limits each page extraction request.
- `SITE_FILE_TIMEOUT_MS` limits robots/sitemap/llms.txt checks, which run in parallel with Firecrawl.

## MVP flow

1. User enters a website URL.
2. The API maps the site with Firecrawl and selects the strongest pages for the MVP scan, falling back quickly when discovery is slow.
3. Firecrawl scrapes selected pages as markdown and continues once enough useful pages are ready.
4. Site file checks for robots.txt, sitemap.xml, and llms.txt run in parallel with extraction.
5. OpenAI returns a structured GEO report with citation gaps, recommendations, AI answer targets, and technical/content signals.
6. Supabase stores the scan result when Supabase credentials are configured.
