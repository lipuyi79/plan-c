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
2. Fill in `FIRECRAWL_API_KEY`, `REPLICATE_API_TOKEN`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
3. Run the Supabase SQL in `supabase/schema.sql`.
4. Install and start:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment variables

```bash
FIRECRAWL_API_KEY=
REPLICATE_API_TOKEN=
OPENAI_MODEL=gpt-5.5
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
FIRECRAWL_MAP_LIMIT=20
SCAN_MAX_PAGES=6
```

`SUPABASE_SERVICE_ROLE_KEY` is only used in the server route. Do not expose it to the browser.

## MVP flow

1. User enters a website URL.
2. The API maps the site with Firecrawl and selects the strongest pages for the MVP scan.
3. Firecrawl scrapes selected pages as markdown.
4. OpenAI returns a structured GEO report with citation gaps, recommendations, AI answer targets, and technical/content signals.
5. Supabase stores the scan result when Supabase credentials are configured.
