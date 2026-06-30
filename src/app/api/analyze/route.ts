import { NextResponse } from "next/server";
import { analyzeSite } from "@/lib/geo-analyzer";
import { AnalyzeRequestSchema } from "@/lib/schema";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_PERSIST_TIMEOUT_MS = 1000;
const MAX_PERSIST_TIMEOUT_MS = 1500;
const DEFAULT_ANALYZE_TIMEOUT_MS = 50000;
const MAX_ANALYZE_TIMEOUT_MS = 52000;

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    const body = await request.json();
    const input = AnalyzeRequestSchema.parse(body);
    const result = await withTimeout(
      (signal) => analyzeSite(input.url, input.language, { signal }),
      getBoundedPositiveInt(process.env.ANALYZE_TIMEOUT_MS, DEFAULT_ANALYZE_TIMEOUT_MS, MAX_ANALYZE_TIMEOUT_MS),
      "Analysis timed out before the 60 second deployment function limit. Try a smaller page or lower crawl/model timeouts."
    );
    const createdAt = new Date().toISOString();
    const scanRecord = await persistScanWithTimeout({
      inputUrl: result.inputUrl,
      siteUrl: result.siteUrl,
      pageCount: result.pages.length,
      pages: result.pages,
      analysis: result.analysis,
      elapsedMs: Date.now() - startedAt,
      createdAt
    });

    return NextResponse.json({
      scan: {
        id: scanRecord.id,
        inputUrl: result.inputUrl,
        siteUrl: result.siteUrl,
        pageCount: result.pages.length,
        pages: result.pages,
        elapsedMs: Date.now() - startedAt,
        persisted: scanRecord.persisted,
        createdAt
      },
      analysis: result.analysis
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed. Please try again later.";

    return NextResponse.json(
      {
        error: message
      },
      {
        status: 400
      }
    );
  }
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

type PersistScanInput = {
  inputUrl: string;
  siteUrl: string;
  pageCount: number;
  pages: unknown;
  analysis: unknown;
  elapsedMs: number;
  createdAt: string;
};

type PersistScanResult = {
  id: string | null;
  persisted: boolean;
};

async function persistScanWithTimeout(input: PersistScanInput): Promise<PersistScanResult> {
  const timeoutMs = getBoundedPositiveInt(process.env.SCAN_PERSIST_TIMEOUT_MS, DEFAULT_PERSIST_TIMEOUT_MS, MAX_PERSIST_TIMEOUT_MS);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      persistScan(input),
      new Promise<PersistScanResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            id: null,
            persisted: false
          });
        }, timeoutMs);
      })
    ]);
  } catch {
    return {
      id: null,
      persisted: false
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function persistScan({
  inputUrl,
  siteUrl,
  pageCount,
  pages,
  analysis,
  elapsedMs,
  createdAt
}: PersistScanInput): Promise<PersistScanResult> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return {
      id: null,
      persisted: false
    };
  }

  const { data, error } = await supabase
    .from("scans")
    .insert({
      input_url: inputUrl,
      site_url: siteUrl,
      page_count: pageCount,
      pages,
      analysis,
      elapsed_ms: elapsedMs,
      created_at: createdAt
    })
    .select("id")
    .single();

  if (error) {
    return {
      id: null,
      persisted: false
    };
  }

  return {
    id: String(data.id),
    persisted: true
  };
}

function getPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getBoundedPositiveInt(value: string | undefined, fallback: number, max: number) {
  return Math.min(getPositiveInt(value, fallback), max);
}
