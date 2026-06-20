import { NextResponse } from "next/server";
import { analyzeSite } from "@/lib/geo-analyzer";
import { AnalyzeRequestSchema } from "@/lib/schema";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    const body = await request.json();
    const input = AnalyzeRequestSchema.parse(body);
    const result = await analyzeSite(input.url, input.language);
    const createdAt = new Date().toISOString();
    const scanRecord = await persistScan({
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

async function persistScan({
  inputUrl,
  siteUrl,
  pageCount,
  pages,
  analysis,
  elapsedMs,
  createdAt
}: {
  inputUrl: string;
  siteUrl: string;
  pageCount: number;
  pages: unknown;
  analysis: unknown;
  elapsedMs: number;
  createdAt: string;
}) {
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
