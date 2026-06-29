import dns from "node:dns/promises";
import net from "node:net";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { GeoAnalysisSchema, type GeoAnalysis, type ScannedPage } from "./schema";

const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
const DEFAULT_MAP_LIMIT = 6;
const DEFAULT_SCAN_MAX_PAGES = 2;
const DEFAULT_SCAN_READY_PAGES = 1;
const DEFAULT_MAP_TIMEOUT_MS = 4000;
const DEFAULT_SCRAPE_TIMEOUT_MS = 12000;
const DEFAULT_SITE_FILE_TIMEOUT_MS = 1500;
const DEFAULT_PAGE_MARKDOWN_LIMIT = 4500;
const DEFAULT_PROMPT_CONTEXT_LIMIT = 18000;

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
  const readyPageCount = Math.min(maxPages, getPositiveInt(process.env.SCAN_READY_PAGES, DEFAULT_SCAN_READY_PAGES));
  const siteFilesPromise = checkSiteFiles(target.siteUrl);
  const [pageContexts, siteFiles] = await Promise.all([
    collectPageContexts(target, firecrawlApiKey, maxPages, readyPageCount),
    siteFilesPromise
  ]);

  if (pageContexts.length === 0) {
    throw new Error("Firecrawl did not return analyzable page content.");
  }

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

async function collectPageContexts(
  target: NormalizedTarget,
  apiKey: string,
  maxPages: number,
  readyPageCount: number
) {
  const initialUrls = pickScanUrls(
    target.inputUrl,
    target.siteUrl,
    [],
    Math.min(maxPages, Math.max(1, readyPageCount))
  );
  const discoveryController = new AbortController();
  const discoveryPromise = discoverUrls(target, apiKey, discoveryController.signal);
  const initialPages = await scrapePages(initialUrls, apiKey, Math.min(readyPageCount, initialUrls.length));

  if (initialPages.length >= readyPageCount) {
    discoveryController.abort();
    return initialPages.slice(0, maxPages);
  }

  const candidateUrls = await discoveryPromise;
  const selectedUrls = pickScanUrls(target.inputUrl, target.siteUrl, candidateUrls, maxPages);
  const seenUrlKeys = new Set(initialUrls.map((url) => toUrlKey(url, target.siteUrl)));
  const extraUrls = selectedUrls
    .filter((url) => !seenUrlKeys.has(toUrlKey(url, target.siteUrl)))
    .slice(0, Math.max(0, maxPages - initialPages.length));

  if (extraUrls.length === 0) {
    return initialPages;
  }

  const extraPages = await scrapePages(
    extraUrls,
    apiKey,
    Math.min(Math.max(1, readyPageCount - initialPages.length), extraUrls.length)
  );

  return dedupePageContexts([...initialPages, ...extraPages]).slice(0, maxPages);
}

async function discoverUrls(target: NormalizedTarget, apiKey: string, signal?: AbortSignal) {
  const limit = getPositiveInt(process.env.FIRECRAWL_MAP_LIMIT, DEFAULT_MAP_LIMIT);
  const timeoutMs = getPositiveInt(process.env.FIRECRAWL_MAP_TIMEOUT_MS, DEFAULT_MAP_TIMEOUT_MS);

  try {
    const response = await firecrawlJson<FirecrawlMapResponse>(
      "/map",
      {
        url: target.siteUrl,
        sitemap: "include",
        includeSubdomains: false,
        ignoreQueryParameters: true,
        limit,
        timeout: timeoutMs
      },
      apiKey,
      {
        timeoutMs,
        signal
      }
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
  const inputKey = toUrlKey(inputUrl, origin);
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
    .sort((a, b) => scoreUrl(a, origin, inputKey) - scoreUrl(b, origin, inputKey))
    .slice(0, Math.max(1, maxPages));
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

async function scrapePages(urls: string[], apiKey: string, readyPageCount: number) {
  if (urls.length === 0) {
    return [];
  }

  const timeoutMs = getPositiveInt(process.env.FIRECRAWL_SCRAPE_TIMEOUT_MS, DEFAULT_SCRAPE_TIMEOUT_MS);
  const targetSuccessCount = Math.min(Math.max(1, readyPageCount), urls.length);
  const controllers = urls.map(() => new AbortController());
  const pages = new Array<PageContext | null>(urls.length).fill(null);
  const settled = new Array<boolean>(urls.length).fill(false);

  return new Promise<PageContext[]>((resolve) => {
    let settledCount = 0;
    let resolved = false;

    const getSuccessfulPages = () => pages.filter((page): page is PageContext => page !== null);
    const resolveWithCurrentPages = (abortPending: boolean) => {
      if (resolved) {
        return;
      }

      resolved = true;

      if (abortPending) {
        controllers.forEach((controller, index) => {
          if (!settled[index]) {
            controller.abort();
          }
        });
      }

      resolve(getSuccessfulPages());
    };

    urls.forEach((url, index) => {
      scrapePage(url, apiKey, timeoutMs, controllers[index].signal)
        .then((page) => {
          if (page.markdown.trim().length > 0) {
            pages[index] = page;
          }
        })
        .catch(() => {
          // Slow or failed pages should not block the whole report.
        })
        .finally(() => {
          settled[index] = true;
          settledCount += 1;

          const primaryPageSettled = settled[0];
          const successfulCount = getSuccessfulPages().length;

          if (successfulCount >= targetSuccessCount && primaryPageSettled) {
            resolveWithCurrentPages(true);
            return;
          }

          if (settledCount === urls.length) {
            resolveWithCurrentPages(false);
          }
        });
    });
  });
}

async function scrapePage(url: string, apiKey: string, timeoutMs: number, signal: AbortSignal): Promise<PageContext> {
  const response = await firecrawlJson<FirecrawlScrapeResponse>(
    "/scrape",
    {
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      onlyCleanContent: true,
      timeout: timeoutMs,
      removeBase64Images: true,
      blockAds: true
    },
    apiKey,
    {
      timeoutMs,
      signal
    }
  );

  if (!response.success || !response.data) {
    throw new Error(response.error ?? "Firecrawl scrape failed");
  }

  const markdown = selectImportantMarkdown(
    response.data.markdown ?? "",
    getPositiveInt(process.env.PAGE_MARKDOWN_LIMIT, DEFAULT_PAGE_MARKDOWN_LIMIT)
  );
  const metadata = response.data.metadata ?? {};

  return {
    url: metadata.sourceURL ?? metadata.url ?? url,
    title: String(metadata.title ?? ""),
    description: String(metadata.description ?? ""),
    wordCount: countWords(markdown),
    markdown
  };
}

async function firecrawlJson<T>(
  path: string,
  body: unknown,
  apiKey: string,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<T> {
  const requestSignal = createRequestSignal(options?.timeoutMs, options?.signal);

  try {
    const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: requestSignal.signal
    });

    const text = await response.text();
    const json = parseJson(text);

    if (!response.ok) {
      const message = typeof json?.error === "string" ? json.error : text;
      throw new Error(`Firecrawl ${response.status}: ${message}`);
    }

    return json as T;
  } catch (error) {
    if (isAbortError(error) && options?.timeoutMs) {
      throw new Error(`Firecrawl ${path} timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`);
    }

    throw error;
  } finally {
    requestSignal.cleanup();
  }
}

async function checkSiteFiles(siteUrl: string): Promise<SiteFileCheck[]> {
  const paths = ["/robots.txt", "/sitemap.xml", "/llms.txt"];
  const timeoutMs = getPositiveInt(process.env.SITE_FILE_TIMEOUT_MS, DEFAULT_SITE_FILE_TIMEOUT_MS);

  return Promise.all(
    paths.map(async (path) => {
      try {
        const response = await fetch(`${siteUrl}${path}`, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs)
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
        "Cleaned important content:",
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
    getPositiveInt(process.env.PROMPT_CONTEXT_LIMIT, DEFAULT_PROMPT_CONTEXT_LIMIT)
  );
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
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

function selectImportantMarkdown(markdown: string, maxLength: number) {
  const cleaned = cleanMarkdown(markdown);

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const blocks = cleaned
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length <= 1) {
    return truncate(cleaned, maxLength);
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
    return truncate(cleaned, maxLength);
  }

  return picked
    .sort((a, b) => a.index - b.index)
    .map((item) => item.block)
    .join("\n\n");
}

function cleanMarkdown(markdown: string) {
  const withoutHeavySyntax = markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]{1,160})]\([^)]+\)/g, "$1")
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
    /^(home|menu|navigation|skip to content|search|cart|checkout|login|log in|sign in|sign up|subscribe|newsletter|privacy|privacy policy|terms|terms of service|cookie|cookies|contact|share|follow us|previous|next|back|learn more|read more|view more|首页|菜单|导航|搜索|购物车|结算|登录|注册|订阅|隐私政策|服务条款|联系我们|分享|上一页|下一页|返回|了解更多|阅读更多)$/i;

  if (shortStandaloneText && standaloneNavigation.test(normalized)) {
    return true;
  }

  const lowValuePatterns = [
    /\b(cookie|cookies|consent|gdpr|ccpa|privacy settings|accept all|reject all)\b/i,
    /\b(copyright|all rights reserved|powered by|website by)\b/i,
    /\b(follow us|share this|share on)\b/i,
    /\b(subscribe to|join our newsletter|enter your email|email address)\b/i,
    /\b(skip to|enable javascript|browser does not support)\b/i,
    /\b(add to cart|view cart|checkout|wishlist)\b/i,
    /(版权所有|保留所有权利|技术支持|网站地图)/,
    /(关注我们|分享到|订阅邮件|输入邮箱|跳至内容)/,
    /(加入购物车|查看购物车|愿望清单)/
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
    /\b(data|research|report|study|statistics|percent|roi|cost|price)\b/g,
    /(产品|服务|功能|方案|解决方案|价格|套餐|客户|案例|评价|评论|证明)/g,
    /(关于|品牌|公司|团队|创始人|使命|常见问题|问答|如何|为什么|对比)/g,
    /(安全|隐私|合规|认证|保证|质保|发货|退货|数据|研究|报告|统计|成本)/g
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
