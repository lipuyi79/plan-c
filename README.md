# GetRecommendedByAi

AI SEO / GEO SaaS MVP. The first version has no user center and no payments. It scans a URL, checks AI crawler and content-structure signals, then returns an AI Citation Score with prioritized citation gaps.

## Stack

- Next.js App Router
- Firecrawl API for site discovery and page extraction
- OpenAI structured outputs for AI citation scoring
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
- `HTML_FETCH_TIMEOUT_MS`
- `SITE_FILE_TIMEOUT_MS`
- `SCAN_MAX_PAGES`
- `SCAN_READY_PAGES`
- `PAGE_MARKDOWN_LIMIT`
- `PROMPT_CONTEXT_LIMIT`
- `SCAN_PERSIST_TIMEOUT_MS`

If the browser shows that the analysis API is not reachable, confirm that the deployed URL is not a static GitHub Pages site and that the environment variables are configured on the server.

## Environment variables

```bash
FIRECRAWL_API_KEY=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://sub2.de5.net/v1
OPENAI_MODEL=gpt-5.5
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
FIRECRAWL_MAP_LIMIT=6
FIRECRAWL_MAP_TIMEOUT_MS=4000
FIRECRAWL_SCRAPE_TIMEOUT_MS=12000
HTML_FETCH_TIMEOUT_MS=5000
SITE_FILE_TIMEOUT_MS=1500
SCAN_MAX_PAGES=2
SCAN_READY_PAGES=1
PAGE_MARKDOWN_LIMIT=4500
PROMPT_CONTEXT_LIMIT=18000
SCAN_PERSIST_TIMEOUT_MS=1500
```

Use the raw API key value only. Do not include shell prefixes such as `export OPENAI_API_KEY=...` or `$env:OPENAI_API_KEY=...` in `.env.local`.

`SUPABASE_SERVICE_ROLE_KEY` is only used in the server route. Do not expose it to the browser.

### Scan speed tuning

- `SCAN_MAX_PAGES` controls how many candidate URLs can be scraped.
- `SCAN_READY_PAGES` lets the report continue once enough useful pages have been extracted. `1` is fastest and works well for focused single-page scans.
- `FIRECRAWL_MAP_TIMEOUT_MS` limits site discovery time before falling back to the submitted URL.
- `FIRECRAWL_SCRAPE_TIMEOUT_MS` limits each page extraction request.
- `HTML_FETCH_TIMEOUT_MS` limits the lightweight HTML fetch used for schema, author, date, and reference detection.
- `SITE_FILE_TIMEOUT_MS` limits robots.txt and sitemap.xml checks, which run in parallel with Firecrawl.
- `PAGE_MARKDOWN_LIMIT` caps cleaned content per page before the model call.
- `PROMPT_CONTEXT_LIMIT` caps the total crawl context sent to OpenAI.
- `SCAN_PERSIST_TIMEOUT_MS` limits how long the API waits for Supabase storage before returning the report.

## MVP flow

1. User enters a website URL.
2. The API immediately scrapes the submitted URL first, while site file checks run in parallel.
3. If the submitted page returns enough useful content, the report skips slower site discovery and moves straight to analysis.
4. If the submitted page is thin or fails, Firecrawl maps the site briefly and scans the strongest fallback pages.
5. Navigation, footer, cookie, social, newsletter, and duplicate Markdown lines are removed before scoring.
6. The analyzer checks robots.txt AI crawler access, sitemap.xml, Title/H1, H2/H3 structure, word count, FAQ, Article/FAQ schema, author, last updated, references, and AI-answer-ready structures.
7. OpenAI returns a structured AI Citation Score and prioritized AI Citation Gap recommendations based on those crawl facts.
8. Supabase stores the scan result when credentials are configured, but slow storage no longer blocks the report indefinitely.
