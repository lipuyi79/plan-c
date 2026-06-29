import dns from "node:dns/promises";
import net from "node:net";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { GeoAnalysisSchema, type GeoAnalysis, type ScannedPage } from "./schema";

const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
const DEFAULT_MAP_LIMIT = 20;
const DEFAULT_SCAN_MAX_PAGES = 6;
const PAGE_MARKDOWN_LIMIT = 6500;
const PROMPT_CONTEXT_LIMIT = 42000;

type NormalizedTarget = {
  inputUrl: string;
  siteUrl: string;
  hostname: string;
};

type FirecrawlMapLink = string | {
  url?: string;
  title?: string;
  description?: string;
};

type FirecrawlMapResponse = {
  success?: boolean;
  links?: FirecrawlMapLink[];
  error?: string;
};

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: {
    markdown?: string;
    links?: string[];
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
      url?: string;
      statusCode?: number;
      error?: string;
      [key: string]: unknown;
    };
    warning?: string;
  };
  error?: string;
};

type PageContext = ScannedPage & {
  markdown: string;
};

type SiteFileCheck = {
  path: string;
  status: "found" | "missing" | "unknown";
  statusCode: number | null;
  snippet: string;
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

  const firecrawlApiKey = getSecretEnv("FIRECRAWL_API_KEY", "The website cannot be scanned.");
  const openaiApiKey = getSecretEnv("OPENAI_API_KEY", "The GEO analysis cannot be generated.");

  const maxPages = getPositiveInt(process.env.SCAN_MAX_PAGES, DEFAULT_SCAN_MAX_PAGES);
  const candidateUrls = await discoverUrls(target, firecrawlApiKey);
  const selectedUrls = pickScanUrls(target.inputUrl, target.siteUrl, candidateUrls, maxPages);
  const pageContexts = await scrapePages(selectedUrls, firecrawlApiKey);

  if (pageContexts.length === 0) {
    throw new Error("Firecrawl did not return analyzable page content.");
  }

  const siteFiles = await checkSiteFiles(target.siteUrl);
  const analysis = await runOpenAiAnalysis({
    target,
    pages: pageContexts,
    siteFiles,
    language,
    openaiApiKey
  });

  return {
    inputUrl: target.inputUrl,
    siteUrl: target.siteUrl,
    pages: pageContexts.map(({ markdown: _markdown, ...page }) => page),
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

async function discoverUrls(target: NormalizedTarget, apiKey: string) {
  const limit = getPositiveInt(process.env.FIRECRAWL_MAP_LIMIT, DEFAULT_MAP_LIMIT);

  try {
    const response = await firecrawlJson<FirecrawlMapResponse>(
      "/map",
      {
        url: target.siteUrl,
        sitemap: "include",
        includeSubdomains: false,
        ignoreQueryParameters: true,
        limit,
        timeout: 30000
      },
      apiKey
    );

    return (response.links ?? [])
      .map((link) => (typeof link === "string" ? link : link.url))
      .filter((url): url is string => Boolean(url));
  } catch {
    return [target.inputUrl];
  }
}

function pickScanUrls(inputUrl: string, siteUrl: string, urls: string[], maxPages: number) {
  const origin = new URL(siteUrl).origin;
  const unique = new Map<string, string>();

  [inputUrl, siteUrl, ...urls].forEach((url) => {
    try {
      const parsed = new URL(url, origin);
      parsed.hash = "";

      if (parsed.origin === origin) {
        unique.set(normalizeUrlKey(parsed), parsed.toString());
      }
    } catch {
      // Ignore malformed URLs returned by third-party APIs.
    }
  });

  return [...unique.values()]
    .sort((a, b) => scoreUrl(a, origin) - scoreUrl(b, origin))
    .slice(0, Math.max(1, maxPages));
}

function normalizeUrlKey(url: URL) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.origin}${pathname}`.toLowerCase();
}

function scoreUrl(url: string, origin: string) {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();

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

async function scrapePages(urls: string[], apiKey: string) {
  const results = await Promise.allSettled(urls.map((url) => scrapePage(url, apiKey)));

  return results
    .filter((result): result is PromiseFulfilledResult<PageContext> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((page) => page.markdown.trim().length > 0);
}

async function scrapePage(url: string, apiKey: string): Promise<PageContext> {
  const response = await firecrawlJson<FirecrawlScrapeResponse>(
    "/scrape",
    {
      url,
      formats: ["markdown", "links"],
      onlyMainContent: true,
      onlyCleanContent: false,
      timeout: 60000,
      removeBase64Images: true,
      blockAds: true
    },
    apiKey
  );

  if (!response.success || !response.data) {
    throw new Error(response.error ?? "Firecrawl scrape failed");
  }

  const markdown = response.data.markdown ?? "";
  const metadata = response.data.metadata ?? {};

  return {
    url: metadata.sourceURL ?? metadata.url ?? url,
    title: String(metadata.title ?? ""),
    description: String(metadata.description ?? ""),
    wordCount: countWords(markdown),
    markdown: truncate(markdown, PAGE_MARKDOWN_LIMIT)
  };
}

async function firecrawlJson<T>(path: string, body: unknown, apiKey: string): Promise<T> {
  const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) {
    const message = typeof json?.error === "string" ? json.error : text;
    throw new Error(`Firecrawl ${response.status}: ${message}`);
  }

  return json as T;
}

async function checkSiteFiles(siteUrl: string): Promise<SiteFileCheck[]> {
  const paths = ["/robots.txt", "/sitemap.xml", "/llms.txt"];

  return Promise.all(
    paths.map(async (path) => {
      try {
        const response = await fetch(`${siteUrl}${path}`, {
          method: "GET",
          signal: AbortSignal.timeout(5000)
        });
        const text = response.ok ? await response.text() : "";

        return {
          path,
          status: response.ok ? "found" : "missing",
          statusCode: response.status,
          snippet: truncate(text, path === "/llms.txt" ? 1800 : 600)
        } satisfies SiteFileCheck;
      } catch {
        return {
          path,
          status: "unknown",
          statusCode: null,
          snippet: ""
        } satisfies SiteFileCheck;
      }
    })
  );
}

async function runOpenAiAnalysis({
  target,
  pages,
  siteFiles,
  language,
  openaiApiKey
}: {
  target: NormalizedTarget;
  pages: PageContext[];
  siteFiles: SiteFileCheck[];
  language: string;
  openaiApiKey: string;
}) {
  const openai = new OpenAI({
    apiKey: openaiApiKey,
    baseURL: getOptionalEnv("OPENAI_BASE_URL")
  });
  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const context = buildPromptContext(target, pages, siteFiles);

  const response = await openai.responses.parse({
    model,
    input: [
      {
        role: "system",
        content: [
          "You are a senior GEO (Generative Engine Optimization) strategist.",
          "Analyze whether an AI answer engine can confidently cite and recommend the scanned website.",
          "Ground every finding in the provided crawl context. If evidence is missing, say it is missing.",
          `Return user-facing content in ${language}.`,
          "Prioritize clear, directly actionable recommendations for an MVP SaaS report."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          "Analyze this website for GEO citation gaps and produce optimization recommendations.",
          "",
          "Scoring guidance:",
          "- 0-39: high risk, AI systems cannot confidently understand or cite the brand.",
          "- 40-69: needs work, core entity is visible but evidence and answer-fit are incomplete.",
          "- 70-100: ready, pages provide clear entity, evidence, and citation-ready content.",
          "",
          "Focus areas:",
          "- Entity clarity: brand, category, audience, geography, use cases.",
          "- Recommendation evidence: pricing, proof, customers, reviews, comparisons, case studies, expert signals.",
          "- Citation-ready passages: concise claims, factual details, unique POV, data, FAQs.",
          "- Technical discoverability: schema markup, sitemap, robots, llms.txt, crawlable pages.",
          "- Query fit: best/vendor/recommended/comparison/problem-solution AI answer prompts.",
          "",
          context
        ].join("\n")
      }
    ],
    text: {
      format: zodTextFormat(GeoAnalysisSchema, "geo_analysis")
    }
  });

  const parsed = response.output_parsed;

  if (!parsed) {
    throw new Error("OpenAI did not return a structured analysis result.");
  }

  return parsed;
}

function buildPromptContext(target: NormalizedTarget, pages: PageContext[], siteFiles: SiteFileCheck[]) {
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
        "Markdown:",
        page.markdown
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return truncate(
    [
      `Input URL: ${target.inputUrl}`,
      `Site URL: ${target.siteUrl}`,
      "",
      "Site file checks:",
      fileContext,
      "",
      "Scanned pages:",
      pageContext
    ].join("\n"),
    PROMPT_CONTEXT_LIMIT
  );
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n[Truncated]`;
}

function countWords(markdown: string) {
  const latinWords = markdown.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g)?.length ?? 0;
  const cjkChars = markdown.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return latinWords + cjkChars;
}

function getPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
