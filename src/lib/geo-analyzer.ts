import dns from "node:dns/promises";
import net from "node:net";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  AiCitationAnalysisSchema,
  type AiCitationAnalysis,
  type AnswerStructureSignal,
  type CrawlChecks,
  type GeoAnalysis,
  type ScannedPage
} from "./schema";

const APIFY_BASE_URL = "https://api.apify.com/v2";
const APIFY_WEBSITE_CONTENT_CRAWLER_ACTOR = "apify~website-content-crawler";
const DEFAULT_SCAN_MAX_PAGES = 1;
const DEFAULT_APIFY_CRAWL_TIMEOUT_MS = 20000;
const MAX_APIFY_CRAWL_TIMEOUT_MS = 25000;
const DEFAULT_APIFY_MAX_CRAWL_DEPTH = 1;
const DEFAULT_APIFY_USE_SITEMAPS = false;
const DEFAULT_HTML_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_SITE_FILE_TIMEOUT_MS = 1500;
const DEFAULT_PAGE_MARKDOWN_LIMIT = 4500;
const DEFAULT_PROMPT_CONTEXT_LIMIT = 18000;
const DEFAULT_HTML_CAPTURE_LIMIT = 120000;
const DEFAULT_OPENAI_TIMEOUT_MS = 22000;
const MAX_OPENAI_TIMEOUT_MS = 25000;
const DEFAULT_OPENAI_MAX_RETRIES = 0;

const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "Google-Extended", "PerplexityBot", "CCBot", "anthropic-ai", "Bytespider"];

type NormalizedTarget = {
  inputUrl: string;
  siteUrl: string;
  hostname: string;
};

type ApifyDatasetItem = Record<string, unknown> & {
  url?: string;
  loadedUrl?: string;
  markdown?: string;
  text?: string;
  html?: string;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  links?: unknown;
  outlinks?: unknown;
};

type PageContext = ScannedPage & {
  markdown: string;
  rawMarkdown: string;
  html: string;
  links: string[];
};

type SiteFileCheck = {
  path: string;
  status: "found" | "missing" | "unknown";
  statusCode: number | null;
  snippet: string;
  content: string;
};

type MarkdownHeading = {
  level: number;
  text: string;
};

type RobotsRule = {
  type: "allow" | "disallow";
  path: string;
  line: string;
};

type RobotsGroup = {
  agents: string[];
  rules: RobotsRule[];
};

export type AnalyzeSiteResult = {
  inputUrl: string;
  siteUrl: string;
  pages: ScannedPage[];
  analysis: GeoAnalysis;
};

export async function analyzeSite(rawUrl: string, language: string): Promise<AnalyzeSiteResult> {
  const target = normalizeTarget(rawUrl);
  await assertPublicTarget(target);

  const apifyToken = getSecretEnv("APIFY_TOKEN", "The website cannot be scanned.");
  const openaiApiKey = getSecretEnv("OPENAI_API_KEY", "The AI citation analysis cannot be generated.");

  const maxPages = getPositiveInt(process.env.SCAN_MAX_PAGES, DEFAULT_SCAN_MAX_PAGES);
  const siteFilesPromise = checkSiteFiles(target.siteUrl);
  const [pageContexts, siteFiles] = await Promise.all([
    collectPageContexts(target, apifyToken, maxPages),
    siteFilesPromise
  ]);

  if (pageContexts.length === 0) {
    throw new Error("Apify did not return analyzable page content.");
  }

  const checks = buildCrawlChecks(target, pageContexts, siteFiles);
  const answerStructures = analyzeAnswerStructures(pageContexts, checks);
  const aiAnalysis = await runOpenAiAnalysis({
    target,
    pages: pageContexts,
    siteFiles,
    checks,
    answerStructures,
    language,
    openaiApiKey
  });
  const analysis = mergeAnalysis(aiAnalysis, checks, answerStructures);

  return {
    inputUrl: target.inputUrl,
    siteUrl: target.siteUrl,
    pages: pageContexts.map(({ markdown: _markdown, rawMarkdown: _rawMarkdown, html: _html, links: _links, ...page }) => page),
    analysis
  };
}

function normalizeTarget(rawUrl: string): NormalizedTarget {
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  parsed.hash = "";
  const inputUrl = parsed.toString();
  const siteUrl = parsed.origin;

  return {
    inputUrl,
    siteUrl,
    hostname: parsed.hostname
  };
}

async function assertPublicTarget(target: NormalizedTarget) {
  const hostname = target.hostname.toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("Local domains cannot be scanned because of SSRF protection.");
  }

  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error("Private network IPs cannot be scanned because of SSRF protection.");
  }

  try {
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("DNS lookup timed out")), 3000);
      })
    ]);

    if (addresses.some((address) => isPrivateIp(address.address))) {
      throw new Error("Domains resolving to private network IPs cannot be scanned because of SSRF protection.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("private network")) {
      throw error;
    }
  }
}

function isPrivateIp(ip: string) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map((part) => Number(part));
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

async function collectPageContexts(target: NormalizedTarget, apiToken: string, maxPages: number) {
  const timeoutMs = getBoundedPositiveInt(
    process.env.APIFY_CRAWL_TIMEOUT_MS,
    DEFAULT_APIFY_CRAWL_TIMEOUT_MS,
    MAX_APIFY_CRAWL_TIMEOUT_MS
  );

  try {
    const items = await apifyRunSync<ApifyDatasetItem[]>(
      APIFY_WEBSITE_CONTENT_CRAWLER_ACTOR,
      {
        startUrls: [{ url: target.inputUrl }],
        maxCrawlPages: maxPages,
        maxResults: maxPages,
        maxCrawlDepth: getPositiveInt(process.env.APIFY_MAX_CRAWL_DEPTH, DEFAULT_APIFY_MAX_CRAWL_DEPTH),
        saveMarkdown: true,
        saveHtml: false,
        useSitemaps: getBooleanEnv(process.env.APIFY_USE_SITEMAPS, DEFAULT_APIFY_USE_SITEMAPS)
      },
      apiToken,
      timeoutMs
    );

    if (!Array.isArray(items)) {
      throw new Error("Apify crawler returned an unexpected response.");
    }

    const pages = await normalizeApifyItems(items, target, maxPages);

    if (pages.length > 0) {
      return pages;
    }
  } catch {
    // Fallback below keeps hosted scans from failing when the crawler is slow.
  }

  const fallbackPage = await fetchFallbackPageContext(target);
  return fallbackPage ? [fallbackPage] : [];
}

async function normalizeApifyItems(items: ApifyDatasetItem[], target: NormalizedTarget, maxPages: number) {
  const origin = new URL(target.siteUrl).origin;
  const inputKey = toUrlKey(target.inputUrl, origin);
  const pages = (await Promise.all(items.map((item) => apifyItemToPageContext(item, target)))).filter(
    (page) => page.rawMarkdown.trim().length > 0 || page.html.trim().length > 0
  );

  return dedupePageContexts(pages)
    .sort((a, b) => scoreUrl(a.url, origin, inputKey) - scoreUrl(b.url, origin, inputKey))
    .slice(0, maxPages);
}

function toUrlKey(url: string, baseUrl: string) {
  try {
    return normalizeUrlKey(new URL(url, baseUrl));
  } catch {
    return url.toLowerCase();
  }
}

function normalizeUrlKey(url: URL) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.origin}${pathname}`.toLowerCase();
}

function scoreUrl(url: string, origin: string, inputKey: string) {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();

  if (normalizeUrlKey(parsed) === inputKey) {
    return -10;
  }

  if (url === origin || path === "/" || path === "") {
    return 0;
  }

  const priorities = [
    "pricing",
    "product",
    "products",
    "service",
    "services",
    "solution",
    "solutions",
    "features",
    "case",
    "customers",
    "about",
    "faq",
    "docs",
    "blog",
    "compare",
    "contact"
  ];

  const matchedIndex = priorities.findIndex((keyword) => path.includes(keyword));
  const depth = path.split("/").filter(Boolean).length;

  return (matchedIndex === -1 ? 50 : matchedIndex + 2) + depth * 3;
}

async function apifyItemToPageContext(item: ApifyDatasetItem, target: NormalizedTarget): Promise<PageContext> {
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const request = isRecord(item.request) ? item.request : {};
  const crawl = isRecord(item.crawl) ? item.crawl : {};
  const url =
    firstString(
      metadata.sourceURL,
      metadata.sourceUrl,
      metadata.url,
      metadata.canonicalUrl,
      item.url,
      item.loadedUrl,
      request.loadedUrl,
      request.url,
      crawl.loadedUrl,
      target.inputUrl
    ) ?? target.inputUrl;
  const rawMarkdown = cleanMarkdown(firstString(item.markdown, item.text, stripHtml(firstString(item.html) ?? "")) ?? "");
  const headings = extractMarkdownHeadings(rawMarkdown);
  const html =
    firstString(item.html) ??
    (await fetchPageHtml(url, getPositiveInt(process.env.HTML_FETCH_TIMEOUT_MS, DEFAULT_HTML_FETCH_TIMEOUT_MS)).catch(() => ""));

  return {
    url,
    title: firstString(metadata.title, item.title) ?? "",
    description: firstString(metadata.description, item.description) ?? "",
    wordCount: countWords(rawMarkdown),
    h1s: headings.filter((heading) => heading.level === 1).map((heading) => heading.text).slice(0, 5),
    h2Count: headings.filter((heading) => heading.level === 2).length,
    h3Count: headings.filter((heading) => heading.level === 3).length,
    markdown: selectImportantMarkdown(rawMarkdown, getPositiveInt(process.env.PAGE_MARKDOWN_LIMIT, DEFAULT_PAGE_MARKDOWN_LIMIT)),
    rawMarkdown,
    html,
    links: normalizeLinks([...extractLinksFromUnknown(item.links), ...extractLinksFromUnknown(item.outlinks)])
  };
}

async function fetchFallbackPageContext(target: NormalizedTarget): Promise<PageContext | null> {
  const html = await fetchPageHtml(target.inputUrl, getPositiveInt(process.env.HTML_FETCH_TIMEOUT_MS, DEFAULT_HTML_FETCH_TIMEOUT_MS));

  if (!html.trim()) {
    return null;
  }

  const rawMarkdown = cleanMarkdown(stripHtml(html));
  const headings = extractMarkdownHeadings(rawMarkdown);

  return {
    url: target.inputUrl,
    title: extractHtmlTitle(html),
    description: getMetaContents(html, ["description", "og:description"]).at(0) ?? "",
    wordCount: countWords(rawMarkdown),
    h1s: headings.filter((heading) => heading.level === 1).map((heading) => heading.text).slice(0, 5),
    h2Count: headings.filter((heading) => heading.level === 2).length,
    h3Count: headings.filter((heading) => heading.level === 3).length,
    markdown: selectImportantMarkdown(rawMarkdown, getPositiveInt(process.env.PAGE_MARKDOWN_LIMIT, DEFAULT_PAGE_MARKDOWN_LIMIT)),
    rawMarkdown,
    html,
    links: normalizeLinks(extractUrls(html))
  };
}

async function fetchPageHtml(url: string, timeoutMs: number, signal?: AbortSignal) {
  const requestSignal = createRequestSignal(timeoutMs, signal);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "GetRecommendedByAiBot/1.0 (+https://getrecommendedbyai.net)"
      },
      redirect: "manual",
      signal: requestSignal.signal
    });
    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok || !/html|text/i.test(contentType)) {
      return "";
    }

    return truncate(await response.text(), DEFAULT_HTML_CAPTURE_LIMIT);
  } catch {
    return "";
  } finally {
    requestSignal.cleanup();
  }
}

async function apifyRunSync<T>(
  actorId: string,
  body: unknown,
  apiToken: string,
  timeoutMs: number
): Promise<T> {
  const requestSignal = createRequestSignal(timeoutMs);
  const url = new URL(`${APIFY_BASE_URL}/acts/${actorId}/run-sync-get-dataset-items`);

  url.searchParams.set("format", "json");
  url.searchParams.set("clean", "true");
  url.searchParams.set("timeout", String(Math.ceil(timeoutMs / 1000)));

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: requestSignal.signal
    });

    const text = await response.text();
    const json = parseJson(text);

    if (!response.ok) {
      throw new Error(`Apify ${response.status}: ${extractApiErrorMessage(json, text)}`);
    }

    return json as T;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Apify ${actorId} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }

    throw error;
  } finally {
    requestSignal.cleanup();
  }
}

async function checkSiteFiles(siteUrl: string): Promise<SiteFileCheck[]> {
  const paths = ["/robots.txt", "/sitemap.xml"];
  const timeoutMs = getPositiveInt(process.env.SITE_FILE_TIMEOUT_MS, DEFAULT_SITE_FILE_TIMEOUT_MS);

  return Promise.all(
    paths.map(async (path) => {
      try {
        const response = await fetch(`${siteUrl}${path}`, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs)
        });
        const text = response.ok ? truncate(await response.text(), DEFAULT_HTML_CAPTURE_LIMIT) : "";

        return {
          path,
          status: response.ok ? "found" : "missing",
          statusCode: response.status,
          snippet: truncate(text, path === "/robots.txt" ? 4000 : 1200),
          content: text
        } satisfies SiteFileCheck;
      } catch {
        return {
          path,
          status: "unknown",
          statusCode: null,
          snippet: "",
          content: ""
        } satisfies SiteFileCheck;
      }
    })
  );
}

function buildCrawlChecks(target: NormalizedTarget, pages: PageContext[], siteFiles: SiteFileCheck[]): CrawlChecks {
  const schemaTypes = detectSchemaTypes(pages);

  return {
    aiCrawlerAccess: buildAiCrawlerAccessCheck(siteFiles),
    sitemap: buildSitemapCheck(siteFiles),
    titleAndH1: buildTitleH1Check(pages[0]),
    headingStructure: buildHeadingStructureCheck(pages[0]),
    contentWordCount: buildWordCountCheck(pages),
    faqPresence: buildFaqCheck(pages, schemaTypes),
    schemaPresence: buildSchemaCheck(schemaTypes),
    authorPresence: buildAuthorCheck(pages),
    lastUpdatedPresence: buildLastUpdatedCheck(pages),
    referencesPresence: buildReferencesCheck(target, pages)
  };
}

function buildAiCrawlerAccessCheck(siteFiles: SiteFileCheck[]): CrawlChecks["aiCrawlerAccess"] {
  const robots = siteFiles.find((file) => file.path === "/robots.txt");

  if (!robots || robots.status === "unknown") {
    return {
      label: "robots.txt allows AI crawlers",
      status: "unknown",
      summary: "robots.txt could not be checked, so AI crawler access is unknown.",
      evidence: ["robots.txt request did not return a usable response."],
      recommendation: "Make robots.txt reachable and explicitly document rules for GPTBot, ClaudeBot, and other AI crawlers.",
      crawlers: AI_CRAWLERS.map((name) => ({
        name,
        permission: "unknown",
        evidence: "robots.txt unavailable"
      }))
    };
  }

  if (robots.status === "missing") {
    return {
      label: "robots.txt allows AI crawlers",
      status: "warning",
      summary: "robots.txt is missing; AI bots are not explicitly blocked, but access is not documented.",
      evidence: [`robots.txt HTTP status: ${robots.statusCode ?? "unknown"}`],
      recommendation: "Add robots.txt and state whether AI crawlers such as GPTBot and ClaudeBot are allowed.",
      crawlers: AI_CRAWLERS.map((name) => ({
        name,
        permission: "unknown",
        evidence: "No explicit robots.txt rule"
      }))
    };
  }

  const groups = parseRobotsGroups(robots.content);
  const crawlers = AI_CRAWLERS.map((name) => evaluateCrawlerAccess(name, groups));
  const blockedCount = crawlers.filter((crawler) => crawler.permission === "blocked").length;
  const unknownCount = crawlers.filter((crawler) => crawler.permission === "unknown").length;

  return {
    label: "robots.txt allows AI crawlers",
    status: blockedCount > 0 ? "fail" : unknownCount > 0 ? "warning" : "pass",
    summary:
      blockedCount > 0
        ? `${blockedCount} AI crawler rule blocks root-level access.`
        : "No root-level AI crawler block was found in robots.txt.",
    evidence: [
      `robots.txt HTTP status: ${robots.statusCode ?? "unknown"}`,
      ...crawlers.slice(0, 4).map((crawler) => `${crawler.name}: ${crawler.permission} (${crawler.evidence})`)
    ],
    recommendation:
      blockedCount > 0
        ? "Update robots.txt if you want AI answer engines to crawl and cite this content."
        : "Keep explicit AI crawler rules documented so access intent is clear.",
    crawlers
  };
}

function buildSitemapCheck(siteFiles: SiteFileCheck[]): CrawlChecks["sitemap"] {
  const sitemap = siteFiles.find((file) => file.path === "/sitemap.xml");
  const exists = sitemap?.status === "found";

  return {
    label: "sitemap.xml exists",
    status: exists ? "pass" : sitemap?.status === "unknown" ? "unknown" : "fail",
    exists,
    summary: exists ? "sitemap.xml is reachable." : "sitemap.xml was not found at the site root.",
    evidence: [`sitemap.xml HTTP status: ${sitemap?.statusCode ?? "unknown"}`],
    recommendation: exists ? "Keep sitemap.xml current as key pages change." : "Publish sitemap.xml with canonical URLs for important pages."
  };
}

function buildTitleH1Check(page: PageContext): CrawlChecks["titleAndH1"] {
  const h1s = page.h1s;
  const issues: string[] = [];

  if (!page.title.trim()) {
    issues.push("Title is missing.");
  } else if (page.title.length < 20 || page.title.length > 70) {
    issues.push(`Title length is ${page.title.length} characters.`);
  }

  if (h1s.length === 0) {
    issues.push("H1 is missing.");
  } else if (h1s.length > 1) {
    issues.push(`${h1s.length} H1 headings were found.`);
  }

  if (h1s[0] && (h1s[0].length < 12 || h1s[0].length > 90)) {
    issues.push(`Primary H1 length is ${h1s[0].length} characters.`);
  }

  const missingCore = !page.title.trim() || h1s.length === 0;

  return {
    label: "Title and H1 quality",
    status: missingCore ? "fail" : issues.length > 0 ? "warning" : "pass",
    title: page.title,
    h1s,
    summary: issues.length > 0 ? "Title/H1 needs cleanup for clearer page identity." : "Title and H1 are present and reasonably scoped.",
    evidence: issues.length > 0 ? issues : [`Title: ${page.title}`, `H1: ${h1s[0]}`],
    recommendation: missingCore
      ? "Add a descriptive title and one clear H1 that names the page topic."
      : "Keep title and H1 specific, concise, and aligned with the page's answer target."
  };
}

function buildHeadingStructureCheck(page: PageContext): CrawlChecks["headingStructure"] {
  const headings = extractMarkdownHeadings(page.rawMarkdown);
  const h2Count = headings.filter((heading) => heading.level === 2).length;
  const h3Count = headings.filter((heading) => heading.level === 3).length;
  const h3BeforeH2 = headings.findIndex((heading) => heading.level === 3) < headings.findIndex((heading) => heading.level === 2);
  const issues: string[] = [];

  if (h2Count === 0 && page.wordCount >= 300) {
    issues.push("No H2 sections were found on a page with substantial content.");
  }

  if (h3Count > 0 && h2Count === 0) {
    issues.push("H3 headings appear without H2 parent sections.");
  }

  if (h3BeforeH2) {
    issues.push("An H3 appears before the first H2.");
  }

  if (h3Count > 0 && h2Count > 0 && h3Count > h2Count * 6) {
    issues.push("H3 usage is heavy compared with H2 sections.");
  }

  return {
    label: "Heading H2/H3 structure",
    status: issues.length > 0 ? "warning" : "pass",
    h2Count,
    h3Count,
    headingOutline: headings
      .filter((heading) => heading.level <= 3)
      .slice(0, 12)
      .map((heading) => `${"  ".repeat(Math.max(0, heading.level - 1))}H${heading.level}: ${heading.text}`),
    summary: issues.length > 0 ? "Heading hierarchy is not fully structured for extraction." : "H2/H3 hierarchy is usable.",
    evidence: issues.length > 0 ? issues : [`H2 count: ${h2Count}`, `H3 count: ${h3Count}`],
    recommendation: "Use H2 for major answer sections and H3 for nested details under the relevant H2."
  };
}

function buildWordCountCheck(pages: PageContext[]): CrawlChecks["contentWordCount"] {
  const totalWordCount = pages.reduce((total, page) => total + page.wordCount, 0);
  const primaryWordCount = pages[0]?.wordCount ?? 0;

  return {
    label: "Content word count",
    status: primaryWordCount < 250 ? "fail" : primaryWordCount < 600 ? "warning" : "pass",
    wordCount: totalWordCount,
    summary: `${totalWordCount} words/chars were extracted across ${pages.length} scanned page${pages.length === 1 ? "" : "s"}.`,
    evidence: pages.map((page) => `${page.url}: ${page.wordCount} words/chars`).slice(0, 4),
    recommendation:
      primaryWordCount < 600
        ? "Add enough original, answer-focused body content for AI systems to understand and cite the page."
        : "Keep the strongest factual passages near relevant headings."
  };
}

function buildFaqCheck(pages: PageContext[], schemaTypes: string[]): CrawlChecks["faqPresence"] {
  const faqSchema = hasSchemaType(schemaTypes, ["FAQPage"]);
  const evidence = detectFaqEvidence(pages);
  const exists = faqSchema || evidence.length > 0;

  return {
    label: "FAQ exists",
    status: exists ? "pass" : "warning",
    exists,
    summary: exists ? "FAQ content or FAQ schema was detected." : "No clear FAQ section was detected.",
    evidence: [...(faqSchema ? ["FAQPage schema detected."] : []), ...evidence].slice(0, 4),
    recommendation: exists
      ? "Keep FAQ answers concise and tied to real user questions."
      : "Add a short FAQ section that answers comparison, pricing, process, and trust questions."
  };
}

function buildSchemaCheck(schemaTypes: string[]): CrawlChecks["schemaPresence"] {
  const articleSchemaExists = hasSchemaType(schemaTypes, ["Article", "NewsArticle", "BlogPosting", "TechArticle"]);
  const faqSchemaExists = hasSchemaType(schemaTypes, ["FAQPage"]);
  const detectedTypes = [...new Set(schemaTypes)].slice(0, 12);
  const hasRelevantSchema = articleSchemaExists || faqSchemaExists;

  return {
    label: "Article / FAQ Schema exists",
    status: hasRelevantSchema ? "pass" : detectedTypes.length > 0 ? "warning" : "fail",
    articleSchemaExists,
    faqSchemaExists,
    detectedTypes,
    summary: hasRelevantSchema ? "Article or FAQ schema was detected." : "No Article or FAQ schema was detected.",
    evidence: detectedTypes.length > 0 ? detectedTypes.map((type) => `Schema type: ${type}`) : ["No JSON-LD Article/FAQPage type found."],
    recommendation: hasRelevantSchema
      ? "Validate structured data whenever content templates change."
      : "Add Article schema for editorial pages and FAQPage schema where Q&A content exists."
  };
}

function buildAuthorCheck(pages: PageContext[]): CrawlChecks["authorPresence"] {
  const authors = extractAuthors(pages);
  const exists = authors.length > 0;

  return {
    label: "Author information exists",
    status: exists ? "pass" : "warning",
    exists,
    authors,
    summary: exists ? "Author information was detected." : "No author information was detected.",
    evidence: exists ? authors.map((author) => `Author: ${author}`) : ["No author meta tag, JSON-LD author, or visible byline found."],
    recommendation: exists
      ? "Keep author names consistent across visible bylines and structured data."
      : "Add a visible author/byline and mirror it in Article schema when appropriate."
  };
}

function buildLastUpdatedCheck(pages: PageContext[]): CrawlChecks["lastUpdatedPresence"] {
  const dates = extractDates(pages);
  const exists = dates.length > 0;

  return {
    label: "Last Updated exists",
    status: exists ? "pass" : "warning",
    exists,
    dates,
    summary: exists ? "A publish or update date was detected." : "No clear publish or update date was detected.",
    evidence: exists ? dates.map((date) => `Date signal: ${date}`) : ["No dateModified, article:modified_time, time[datetime], or visible update text found."],
    recommendation: exists
      ? "Prefer dateModified for updates and keep visible dates aligned with schema."
      : "Add a visible last-updated date and dateModified structured data for time-sensitive content."
  };
}

function buildReferencesCheck(target: NormalizedTarget, pages: PageContext[]): CrawlChecks["referencesPresence"] {
  const references = extractReferences(target, pages);
  const exists = references.length > 0;

  return {
    label: "References exist",
    status: exists ? "pass" : "warning",
    exists,
    references,
    summary: exists ? "Reference/source signals were detected." : "No clear reference/source section was detected.",
    evidence: exists ? references.slice(0, 5) : ["No References/Sources heading or credible external citation links found."],
    recommendation: exists
      ? "Keep source links close to the claims they support."
      : "Add a References or Sources section with authoritative citations for factual claims."
  };
}

function analyzeAnswerStructures(pages: PageContext[], checks: CrawlChecks): AnswerStructureSignal[] {
  const text = pages.map((page) => `${page.rawMarkdown}\n${stripHtml(page.html)}`).join("\n\n").toLowerCase();

  return [
    {
      name: "Summary",
      present: /(\bsummary\b|\boverview\b|\bkey takeaways\b|\btl;dr\b|\u6458\u8981|\u6982\u89c8|\u8981\u70b9)/i.test(text),
      evidence: "Looks for explicit summary, overview, key takeaways, TL;DR, or equivalent headings."
    },
    {
      name: "Steps",
      present: /(\bstep\s*\d+\b|\bhow to\b|\bprocess\b|\bworkflow\b|\u6b65\u9aa4|\u6d41\u7a0b)/i.test(text),
      evidence: "Looks for step-by-step process or how-to structure."
    },
    {
      name: "Pros and cons",
      present: /(\bpros?\b.*\bcons?\b|\badvantages?\b|\bdisadvantages?\b|\u4f18\u7f3a\u70b9|\u4f18\u70b9|\u7f3a\u70b9)/is.test(text),
      evidence: "Looks for pros/cons or advantages/disadvantages sections."
    },
    {
      name: "Comparison",
      present: /(\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b|\balternative\b|\|[-:\s|]{3,}\||\u5bf9\u6bd4|\u6bd4\u8f83)/i.test(text),
      evidence: "Looks for comparison language, alternatives, versus framing, or Markdown tables."
    },
    {
      name: "FAQ answers",
      present: checks.faqPresence.exists,
      evidence: checks.faqPresence.exists ? "FAQ content or FAQPage schema was detected." : "No FAQ signal was detected."
    },
    {
      name: "Trust evidence",
      present: checks.authorPresence.exists || checks.referencesPresence.exists || checks.lastUpdatedPresence.exists,
      evidence: "Looks for author, update date, or source/reference signals that support citation confidence."
    }
  ];
}

async function runOpenAiAnalysis({
  target,
  pages,
  siteFiles,
  checks,
  answerStructures,
  language,
  openaiApiKey
}: {
  target: NormalizedTarget;
  pages: PageContext[];
  siteFiles: SiteFileCheck[];
  checks: CrawlChecks;
  answerStructures: AnswerStructureSignal[];
  language: string;
  openaiApiKey: string;
}): Promise<AiCitationAnalysis> {
  const timeout = getBoundedPositiveInt(process.env.OPENAI_TIMEOUT_MS, DEFAULT_OPENAI_TIMEOUT_MS, MAX_OPENAI_TIMEOUT_MS);
  const openai = new OpenAI({
    apiKey: openaiApiKey,
    baseURL: getOptionalEnv("OPENAI_BASE_URL"),
    timeout,
    maxRetries: getNonNegativeInt(process.env.OPENAI_MAX_RETRIES, DEFAULT_OPENAI_MAX_RETRIES)
  });
  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const context = buildPromptContext(target, pages, siteFiles, checks, answerStructures);

  const response = await openai.responses.parse(
    {
      model,
      input: [
        {
          role: "system",
          content: [
            "You are a senior AI citation and answer-engine readiness auditor.",
            "Use the provided crawl audit as the source of truth.",
            "Do not claim robots, schema, author, dates, references, or FAQ exist unless the local audit says they exist.",
            `Return user-facing content in ${language}.`,
            "Score how likely the page is to be confidently cited by AI answer engines."
          ].join(" ")
        },
        {
          role: "user",
          content: [
            "Create the AI Citation Score and AI Citation Gap recommendations for this website.",
            "",
            "Scoring guidance:",
            "- 0-39: high risk, key crawlability, identity, evidence, or structure signals are absent.",
            "- 40-69: needs work, the page is understandable but missing important citation support.",
            "- 70-84: good, mostly citation-ready with a few optimization gaps.",
            "- 85-100: excellent, highly structured, current, evidence-backed, and AI-crawler accessible.",
            "",
            "Prioritize gaps in this order when evidence supports them:",
            "1. AI crawler access and sitemap discoverability.",
            "2. Title/H1 and H2/H3 answer structure.",
            "3. Article/FAQ schema, FAQ, author, update date, and references.",
            "4. Summary, steps, pros/cons, comparisons, and other answer-ready formats.",
            "",
            context
          ].join("\n")
        }
      ],
      text: {
        format: zodTextFormat(AiCitationAnalysisSchema, "ai_citation_analysis")
      }
    },
    {
      timeout
    }
  );

  const parsed = response.output_parsed;

  if (!parsed) {
    throw new Error("OpenAI did not return a structured AI citation analysis result.");
  }

  return parsed;
}

function buildPromptContext(
  target: NormalizedTarget,
  pages: PageContext[],
  siteFiles: SiteFileCheck[],
  checks: CrawlChecks,
  answerStructures: AnswerStructureSignal[]
) {
  const fileContext = siteFiles
    .map((file) => {
      return [
        `FILE: ${file.path}`,
        `Status: ${file.status}`,
        `HTTP: ${file.statusCode ?? "unknown"}`,
        file.snippet ? `Snippet:\n${file.snippet}` : "Snippet: none"
      ].join("\n");
    })
    .join("\n\n");

  const pageContext = pages
    .map((page, index) => {
      return [
        `PAGE ${index + 1}`,
        `URL: ${page.url}`,
        `Title: ${page.title || "Unknown"}`,
        `Description: ${page.description || "Unknown"}`,
        `Word count estimate: ${page.wordCount}`,
        `H1: ${page.h1s.join(" | ") || "None"}`,
        `H2 count: ${page.h2Count}`,
        `H3 count: ${page.h3Count}`,
        "Cleaned important content:",
        page.markdown
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return truncate(
    [
      `Input URL: ${target.inputUrl}`,
      `Site URL: ${target.siteUrl}`,
      `Local heuristic score: ${buildLocalScore(checks, answerStructures)}/100`,
      "",
      "Local crawl audit JSON:",
      JSON.stringify({ checks, answerStructures }, null, 2),
      "",
      "Site file checks:",
      fileContext,
      "",
      "Scanned pages:",
      pageContext
    ].join("\n"),
    getPositiveInt(process.env.PROMPT_CONTEXT_LIMIT, DEFAULT_PROMPT_CONTEXT_LIMIT)
  );
}

function mergeAnalysis(
  aiAnalysis: AiCitationAnalysis,
  checks: CrawlChecks,
  answerStructures: AnswerStructureSignal[]
): GeoAnalysis {
  return {
    summary: {
      ...aiAnalysis.summary,
      aiCitationScore: clampScore(aiAnalysis.summary.aiCitationScore)
    },
    checks,
    aiAnswerReadiness: {
      ...aiAnalysis.aiAnswerReadiness,
      structures: answerStructures
    },
    aiCitationGaps: aiAnalysis.aiCitationGaps.slice(0, 8)
  };
}

function parseRobotsGroups(content: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup = {
    agents: [],
    rules: []
  };

  content.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.replace(/#.*/, "").trim();

    if (!line || !line.includes(":")) {
      return;
    }

    const [rawDirective, ...rawValue] = line.split(":");
    const directive = rawDirective.trim().toLowerCase();
    const value = rawValue.join(":").trim();

    if (directive === "user-agent") {
      if (current.agents.length > 0 && current.rules.length > 0) {
        groups.push(current);
        current = {
          agents: [],
          rules: []
        };
      }

      current.agents.push(value.toLowerCase());
      return;
    }

    if ((directive === "allow" || directive === "disallow") && current.agents.length > 0) {
      current.rules.push({
        type: directive,
        path: value,
        line: `${directive}: ${value || "(empty)"}`
      });
    }
  });

  if (current.agents.length > 0) {
    groups.push(current);
  }

  return groups;
}

function evaluateCrawlerAccess(name: string, groups: RobotsGroup[]): CrawlChecks["aiCrawlerAccess"]["crawlers"][number] {
  const lowerName = name.toLowerCase();
  const matchingGroups = groups.filter((group) => group.agents.some((agent) => agentMatchesCrawler(agent, lowerName)));

  if (matchingGroups.length === 0) {
    return {
      name,
      permission: "allowed",
      evidence: "No matching disallow rule"
    };
  }

  const specificity = Math.max(...matchingGroups.flatMap((group) => group.agents.map((agent) => (agent === "*" ? 1 : agent.length))));
  const rules = matchingGroups
    .filter((group) => group.agents.some((agent) => (agent === "*" ? specificity === 1 : agent.length === specificity)))
    .flatMap((group) => group.rules);
  const rootRules = rules
    .filter((rule) => rule.path === "" || rule.path === "/" || "/".startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length || (a.type === "allow" ? -1 : 1));
  const winner = rootRules[0];

  if (!winner || winner.type === "allow" || winner.path === "") {
    return {
      name,
      permission: "allowed",
      evidence: winner?.line ?? "No root-level disallow rule"
    };
  }

  return {
    name,
    permission: "blocked",
    evidence: winner.line
  };
}

function agentMatchesCrawler(agent: string, crawler: string) {
  return agent === "*" || crawler === agent || crawler.includes(agent) || agent.includes(crawler);
}

function detectSchemaTypes(pages: PageContext[]) {
  const types = new Set<string>();

  pages.forEach((page) => {
    extractJsonLd(page.html).forEach((value) => collectSchemaTypes(value, types));

    for (const match of page.html.matchAll(/schema\.org\/([A-Za-z][A-Za-z0-9_-]+)/g)) {
      types.add(match[1]);
    }
  });

  return [...types];
}

function extractJsonLd(html: string) {
  const values: unknown[] = [];

  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = decodeHtmlEntities(match[1].trim());

    try {
      values.push(JSON.parse(text));
    } catch {
      // Ignore malformed JSON-LD.
    }
  }

  return values;
}

function collectSchemaTypes(value: unknown, types: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSchemaTypes(item, types));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const rawType = value["@type"];

  if (Array.isArray(rawType)) {
    rawType.forEach((type) => {
      if (typeof type === "string") {
        types.add(type);
      }
    });
  } else if (typeof rawType === "string") {
    types.add(rawType);
  }

  Object.values(value).forEach((nested) => {
    if (Array.isArray(nested) || isRecord(nested)) {
      collectSchemaTypes(nested, types);
    }
  });
}

function hasSchemaType(types: string[], candidates: string[]) {
  const normalized = types.map((type) => type.toLowerCase());
  return candidates.some((candidate) => normalized.includes(candidate.toLowerCase()));
}

function detectFaqEvidence(pages: PageContext[]) {
  const evidence = new Set<string>();

  pages.forEach((page) => {
    const text = page.rawMarkdown;

    if (/^#{1,4}\s+(faq|frequently asked questions|\u5e38\u89c1\u95ee\u9898|\u95ee\u7b54)\b/im.test(text)) {
      evidence.add(`FAQ heading found on ${page.url}`);
    }

    if (/(^|\n)(q:|question:|\*\*q:)/i.test(text) || (text.match(/\?\s*(\n|$)/g)?.length ?? 0) >= 3) {
      evidence.add(`Question-answer patterns found on ${page.url}`);
    }
  });

  return [...evidence];
}

function extractAuthors(pages: PageContext[]) {
  const authors = new Set<string>();

  pages.forEach((page) => {
    extractJsonLd(page.html).forEach((value) => collectNamedValues(value, ["author"], authors));
    getMetaContents(page.html, ["author", "article:author", "og:article:author"]).forEach((author) => authors.add(author));

    for (const match of page.rawMarkdown.matchAll(/\b(by|author|written by|reviewed by)\s*:?\s+([^\n|]{2,80})/gi)) {
      authors.add(cleanEvidence(match[2]));
    }

    for (const match of page.rawMarkdown.matchAll(/(\u4f5c\u8005|\u64b0\u5199)\s*[:：]\s*([^\n|]{2,80})/g)) {
      authors.add(cleanEvidence(match[2]));
    }
  });

  return [...authors].filter(Boolean).slice(0, 6);
}

function extractDates(pages: PageContext[]) {
  const dates = new Set<string>();

  pages.forEach((page) => {
    extractJsonLd(page.html).forEach((value) => collectNamedValues(value, ["dateModified", "datePublished", "uploadDate"], dates));
    getMetaContents(page.html, ["article:modified_time", "article:published_time", "date", "last-modified", "pubdate"]).forEach((date) =>
      dates.add(date)
    );

    for (const match of page.html.matchAll(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/gi)) {
      dates.add(cleanEvidence(match[1]));
    }

    for (const match of page.rawMarkdown.matchAll(
      /\b(last updated|updated on|published on|modified|date)\b\s*:?\s*([^\n]{4,80})/gi
    )) {
      dates.add(cleanEvidence(`${match[1]} ${match[2]}`));
    }

    for (const match of page.rawMarkdown.matchAll(/(\u6700\u540e\u66f4\u65b0|\u66f4\u65b0\u65f6\u95f4|\u53d1\u5e03\u65e5\u671f)\s*[:：]?\s*([^\n]{4,80})/g)) {
      dates.add(cleanEvidence(`${match[1]} ${match[2]}`));
    }
  });

  return [...dates].filter(Boolean).slice(0, 8);
}

function extractReferences(target: NormalizedTarget, pages: PageContext[]) {
  const references = new Set<string>();
  const siteHostname = target.hostname.toLowerCase();

  pages.forEach((page) => {
    for (const match of page.rawMarkdown.matchAll(/^#{1,4}\s+(references|sources|citations|bibliography|further reading|\u53c2\u8003|\u6765\u6e90|\u8d44\u6599)\b.*$/gim)) {
      references.add(`Reference heading: ${cleanEvidence(match[0])}`);
    }

    extractUrls(`${page.rawMarkdown}\n${page.html}\n${page.links.join("\n")}`)
      .filter((url) => isCredibleExternalUrl(url, siteHostname))
      .slice(0, 8)
      .forEach((url) => references.add(url));
  });

  return [...references].slice(0, 8);
}

function collectNamedValues(value: unknown, names: string[], output: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedValues(item, names, output));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  names.forEach((name) => {
    const raw = value[name];
    stringifySchemaValue(raw).forEach((item) => output.add(item));
  });

  Object.values(value).forEach((nested) => {
    if (Array.isArray(nested) || isRecord(nested)) {
      collectNamedValues(nested, names, output);
    }
  });
}

function stringifySchemaValue(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string" || typeof value === "number") {
    return [cleanEvidence(String(value))];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => stringifySchemaValue(item));
  }

  if (isRecord(value)) {
    const name = value.name;

    if (typeof name === "string") {
      return [cleanEvidence(name)];
    }
  }

  return [];
}

function getMetaContents(html: string, names: string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const values: string[] = [];

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.name ?? attrs.property ?? attrs.itemprop ?? "").toLowerCase();
    const content = attrs.content;

    if (content && wanted.has(key)) {
      values.push(cleanEvidence(content));
    }
  }

  return values;
}

function extractHtmlTitle(html: string) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanEvidence(match[1]) : "";
}

function parseAttributes(tag: string) {
  const attrs: Record<string, string> = {};

  for (const match of tag.matchAll(/([A-Za-z_:.-]+)\s*=\s*["']([^"']*)["']/g)) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2]);
  }

  return attrs;
}

function extractUrls(text: string) {
  return [...new Set((text.match(/https?:\/\/[^\s"'<>)+\]]+/gi) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

function isCredibleExternalUrl(rawUrl: string, siteHostname: string) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const normalizedSite = siteHostname.replace(/^www\./, "");

    if (hostname === normalizedSite || hostname.endsWith(`.${normalizedSite}`)) {
      return false;
    }

    if (/\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?)$/i.test(parsed.pathname)) {
      return false;
    }

    return !/(facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok|pinterest|wa\.me|mailto|tel)/i.test(hostname);
  } catch {
    return false;
  }
}

function buildLocalScore(checks: CrawlChecks, answerStructures: AnswerStructureSignal[]) {
  const weightedStatuses: Array<[CrawlChecks[keyof CrawlChecks]["status"], number]> = [
    [checks.aiCrawlerAccess.status, 10],
    [checks.sitemap.status, 8],
    [checks.titleAndH1.status, 12],
    [checks.headingStructure.status, 10],
    [checks.contentWordCount.status, 8],
    [checks.faqPresence.status, 8],
    [checks.schemaPresence.status, 12],
    [checks.authorPresence.status, 8],
    [checks.lastUpdatedPresence.status, 8],
    [checks.referencesPresence.status, 8]
  ];
  const structureWeight = 8;
  const checkScore = weightedStatuses.reduce((total, [status, weight]) => total + statusScore(status) * weight, 0);
  const structureScore =
    answerStructures.reduce((total, signal) => total + (signal.present ? structureWeight : 0), 0) /
    Math.max(1, answerStructures.length);

  return clampScore(checkScore + structureScore);
}

function statusScore(status: CrawlChecks[keyof CrawlChecks]["status"]) {
  if (status === "pass") {
    return 1;
  }

  if (status === "warning") {
    return 0.55;
  }

  if (status === "unknown") {
    return 0.35;
  }

  return 0;
}

function extractApiErrorMessage(json: unknown, fallback: string) {
  if (isRecord(json)) {
    if (typeof json.error === "string") {
      return json.error;
    }

    if (isRecord(json.error) && typeof json.error.message === "string") {
      return json.error.message;
    }

    if (typeof json.message === "string") {
      return json.message;
    }
  }

  return fallback;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function createRequestSignal(timeoutMs?: number, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const abortFromExternal = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n[Truncated]`;
}

function dedupePageContexts(pages: PageContext[]) {
  const seen = new Set<string>();
  const uniquePages: PageContext[] = [];

  pages.forEach((page) => {
    const key = toUrlKey(page.url, page.url);

    if (!seen.has(key)) {
      seen.add(key);
      uniquePages.push(page);
    }
  });

  return uniquePages;
}

function selectImportantMarkdown(cleanedMarkdown: string, maxLength: number) {
  if (cleanedMarkdown.length <= maxLength) {
    return cleanedMarkdown;
  }

  const blocks = cleanedMarkdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length <= 1) {
    return truncate(cleanedMarkdown, maxLength);
  }

  const selected = blocks
    .map((block, index) => ({
      block,
      index,
      score: scoreImportantBlock(block) + Math.max(0, 8 - index)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const picked: typeof selected = [];
  let usedLength = 0;

  for (const item of selected) {
    const separatorLength = picked.length === 0 ? 0 : 2;

    if (usedLength + separatorLength + item.block.length > maxLength) {
      continue;
    }

    picked.push(item);
    usedLength += separatorLength + item.block.length;

    if (usedLength >= maxLength * 0.95) {
      break;
    }
  }

  if (picked.length === 0) {
    return truncate(cleanedMarkdown, maxLength);
  }

  return picked
    .sort((a, b) => a.index - b.index)
    .map((item) => item.block)
    .join("\n\n");
}

function cleanMarkdown(markdown: string) {
  const withoutHeavySyntax = markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const seen = new Set<string>();
  const keptLines: string[] = [];
  let previousBlank = false;

  withoutHeavySyntax.split(/\r?\n/).forEach((rawLine) => {
    const line = normalizeContentLine(rawLine);

    if (!line) {
      if (!previousBlank && keptLines.length > 0) {
        keptLines.push("");
      }

      previousBlank = true;
      return;
    }

    previousBlank = false;

    if (isLowValueMarkdownLine(line)) {
      return;
    }

    const dedupeKey = normalizeForDedupe(line);

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    keptLines.push(line);
  });

  return keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];

  for (const match of markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    headings.push({
      level: match[1].length,
      text: cleanEvidence(match[2].replace(/#+$/, ""))
    });
  }

  return headings;
}

function normalizeLinks(links: string[]) {
  return [...new Set(links.filter((link) => /^https?:\/\//i.test(link)))].slice(0, 80);
}

function extractLinksFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractLinksFromUnknown(item));
  }

  if (isRecord(value)) {
    const url = firstString(value.url, value.href);
    return url ? [url] : [];
  }

  return [];
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeContentLine(line: string) {
  return line
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function normalizeForDedupe(line: string) {
  return line
    .toLowerCase()
    .replace(/[`*_#[\](){}|.,:;!?'"<>/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowValueMarkdownLine(line: string) {
  const normalized = normalizeForDedupe(line);

  if (!normalized || normalized.length < 3) {
    return true;
  }

  const isHeading = /^#{1,6}\s+/.test(line);
  const shortStandaloneText = normalized.length <= 36;
  const standaloneNavigation =
    /^(home|menu|navigation|skip to content|search|cart|checkout|login|log in|sign in|sign up|subscribe|newsletter|privacy|privacy policy|terms|terms of service|cookie|cookies|contact|share|follow us|previous|next|back|learn more|read more|view more)$/i;

  if (shortStandaloneText && standaloneNavigation.test(normalized)) {
    return true;
  }

  const lowValuePatterns = [
    /\b(cookie|cookies|consent|gdpr|ccpa|privacy settings|accept all|reject all)\b/i,
    /\b(copyright|all rights reserved|powered by|website by)\b/i,
    /\b(follow us|share this|share on)\b/i,
    /\b(subscribe to|join our newsletter|enter your email|email address)\b/i,
    /\b(skip to|enable javascript|browser does not support)\b/i,
    /\b(add to cart|view cart|checkout|wishlist)\b/i
  ];

  if (lowValuePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (shortStandaloneText && /\b(facebook|instagram|linkedin|twitter|youtube|tiktok)\b/i.test(normalized)) {
    return true;
  }

  const navTerms = normalized.match(/\b(home|about|pricing|blog|contact|login|sign up|products|services|features)\b/g) ?? [];

  if (!isHeading && navTerms.length >= 4 && normalized.length < 160) {
    return true;
  }

  return false;
}

function scoreImportantBlock(block: string) {
  const text = block.toLowerCase();
  let score = 0;

  if (/^#{1,6}\s+/m.test(block)) {
    score += 8;
  }

  const importantPatterns = [
    /\b(product|products|service|services|feature|features|solution|solutions|pricing|plans?)\b/g,
    /\b(customer|customers|case stud|review|reviews|testimonial|results?|proof|evidence)\b/g,
    /\b(about|brand|company|team|founder|mission|who we are)\b/g,
    /\b(faq|question|answer|how it works|why|compare|comparison|alternative)\b/g,
    /\b(security|privacy|compliance|certified|guarantee|warranty|shipping|returns?)\b/g,
    /\b(data|research|report|study|statistics|percent|roi|cost|price)\b/g
  ];

  importantPatterns.forEach((pattern) => {
    score += (text.match(pattern)?.length ?? 0) * 3;
  });

  if (/\d/.test(block)) {
    score += 2;
  }

  if (block.length > 1800) {
    score -= 4;
  }

  return score;
}

function countWords(markdown: string) {
  const latinWords = markdown.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g)?.length ?? 0;
  const cjkChars = markdown.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return latinWords + cjkChars;
}

function stripHtml(html: string) {
  return decodeHtmlEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function cleanEvidence(value: string) {
  return decodeHtmlEntities(value)
    .replace(/\s+/g, " ")
    .replace(/^[#*\-\s:：]+|[#*\-\s]+$/g, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getBoundedPositiveInt(value: string | undefined, fallback: number, max: number) {
  return Math.min(getPositiveInt(value, fallback), max);
}

function getNonNegativeInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function getBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }

  if (/^(1|true|yes|on)$/i.test(value.trim())) {
    return true;
  }

  if (/^(0|false|no|off)$/i.test(value.trim())) {
    return false;
  }

  return fallback;
}

function getSecretEnv(name: string, purpose: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name}. ${purpose}`);
  }

  if (/^(export\s+|\$env:)/i.test(value)) {
    throw new Error(`${name} must be the raw key value, not a shell assignment command.`);
  }

  return value;
}

function getOptionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}
