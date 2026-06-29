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
- `SCAN_MAX_PAGES`

If the browser shows that the analysis API is not reachable, confirm that the deployed URL is not a static GitHub Pages site and that the environment variables are configured on the server.

## Environment variables

```bash
FIRECRAWL_API_KEY=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://sub2.de5.net/v1
OPENAI_MODEL=gpt-5.5
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
FIRECRAWL_MAP_LIMIT=20
SCAN_MAX_PAGES=6
```

Use the raw API key value only. Do not include shell prefixes such as `export OPENAI_API_KEY=...` or `$env:OPENAI_API_KEY=...` in `.env.local`.

`SUPABASE_SERVICE_ROLE_KEY` is only used in the server route. Do not expose it to the browser.

## MVP flow

1. User enters a website URL.
2. The API maps the site with Firecrawl and selects the strongest pages for the MVP scan.
3. Firecrawl scrapes selected pages as markdown.
4. OpenAI returns a structured GEO report with citation gaps, recommendations, AI answer targets, and technical/content signals.
5. Supabase stores the scan result when Supabase credentials are configured.
