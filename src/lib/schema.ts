import { z } from "zod";

export const AnalyzeRequestSchema = z.object({
  url: z.string().trim().min(1, "Enter a website URL."),
  language: z.string().trim().default("en-US")
});

export const GapSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const PrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export const EffortSchema = z.enum(["low", "medium", "high"]);
export const ImpactSchema = z.enum(["low", "medium", "high"]);
export const SupportLevelSchema = z.enum(["strong", "partial", "weak", "missing"]);
export const VerdictSchema = z.enum(["ready", "needs_work", "high_risk"]);

export const GeoAnalysisSchema = z.object({
  summary: z.object({
    brandName: z.string(),
    domain: z.string(),
    detectedBusinessType: z.string(),
    primaryAudience: z.string(),
    oneSentenceDiagnosis: z.string(),
    readinessScore: z.number(),
    verdict: VerdictSchema
  }),
  citationGaps: z.array(
    z.object({
      area: z.string(),
      severity: GapSeveritySchema,
      evidence: z.string(),
      whyItMatters: z.string(),
      affectedPages: z.array(z.string())
    })
  ),
  recommendations: z.array(
    z.object({
      title: z.string(),
      priority: PrioritySchema,
      effort: EffortSchema,
      impact: ImpactSchema,
      targetPage: z.string(),
      rationale: z.string(),
      actions: z.array(z.string()),
      exampleCopy: z.string(),
      successMetric: z.string()
    })
  ),
  aiAnswerTargets: z.array(
    z.object({
      query: z.string(),
      expectedMention: z.string(),
      currentSupportLevel: SupportLevelSchema,
      missingEvidence: z.array(z.string())
    })
  ),
  contentSignals: z.object({
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    missingArtifacts: z.array(z.string())
  }),
  technicalSignals: z.object({
    schemaMarkup: z.string(),
    faqCoverage: z.string(),
    authorTrust: z.string(),
    freshness: z.string(),
    crawlability: z.string(),
    llmsTxt: z.string(),
    sitemapClarity: z.string()
  }),
  quickWins: z.array(z.string()),
  nextSteps: z.array(z.string())
});

export type GeoAnalysis = z.infer<typeof GeoAnalysisSchema>;
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

export type ScannedPage = {
  url: string;
  title: string;
  description: string;
  wordCount: number;
};

export type AnalyzeApiResponse = {
  scan: {
    id: string | null;
    inputUrl: string;
    siteUrl: string;
    pageCount: number;
    pages: ScannedPage[];
    elapsedMs: number;
    persisted: boolean;
    createdAt: string;
  };
  analysis: GeoAnalysis;
};
