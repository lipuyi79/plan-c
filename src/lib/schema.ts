import { z } from "zod";

export const AnalyzeRequestSchema = z.object({
  url: z.string().trim().min(1, "Enter a website URL."),
  language: z.string().trim().default("en-US")
});

export const AuditStatusSchema = z.enum(["pass", "warning", "fail", "unknown"]);
export const CrawlerPermissionSchema = z.enum(["allowed", "blocked", "unknown"]);
export const PrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export const CitationVerdictSchema = z.enum(["excellent", "good", "needs_work", "high_risk"]);

export const AuditCheckSchema = z.object({
  label: z.string(),
  status: AuditStatusSchema,
  summary: z.string(),
  evidence: z.array(z.string()),
  recommendation: z.string()
});

export const AiCrawlerCheckSchema = AuditCheckSchema.extend({
  crawlers: z.array(
    z.object({
      name: z.string(),
      permission: CrawlerPermissionSchema,
      evidence: z.string()
    })
  )
});

export const TitleH1CheckSchema = AuditCheckSchema.extend({
  title: z.string(),
  h1s: z.array(z.string())
});

export const HeadingStructureCheckSchema = AuditCheckSchema.extend({
  h2Count: z.number(),
  h3Count: z.number(),
  headingOutline: z.array(z.string())
});

export const WordCountCheckSchema = AuditCheckSchema.extend({
  wordCount: z.number()
});

export const BooleanPresenceCheckSchema = AuditCheckSchema.extend({
  exists: z.boolean()
});

export const SchemaPresenceCheckSchema = AuditCheckSchema.extend({
  articleSchemaExists: z.boolean(),
  faqSchemaExists: z.boolean(),
  detectedTypes: z.array(z.string())
});

export const AuthorPresenceCheckSchema = AuditCheckSchema.extend({
  exists: z.boolean(),
  authors: z.array(z.string())
});

export const LastUpdatedPresenceCheckSchema = AuditCheckSchema.extend({
  exists: z.boolean(),
  dates: z.array(z.string())
});

export const ReferencesPresenceCheckSchema = AuditCheckSchema.extend({
  exists: z.boolean(),
  references: z.array(z.string())
});

export const CrawlChecksSchema = z.object({
  aiCrawlerAccess: AiCrawlerCheckSchema,
  sitemap: BooleanPresenceCheckSchema,
  titleAndH1: TitleH1CheckSchema,
  headingStructure: HeadingStructureCheckSchema,
  contentWordCount: WordCountCheckSchema,
  faqPresence: BooleanPresenceCheckSchema,
  schemaPresence: SchemaPresenceCheckSchema,
  authorPresence: AuthorPresenceCheckSchema,
  lastUpdatedPresence: LastUpdatedPresenceCheckSchema,
  referencesPresence: ReferencesPresenceCheckSchema
});

export const AnswerStructureSignalSchema = z.object({
  name: z.string(),
  present: z.boolean(),
  evidence: z.string()
});

export const AiAnswerReadinessBaseSchema = z.object({
  status: AuditStatusSchema,
  summary: z.string(),
  missingStructures: z.array(z.string()),
  suggestedAnswerShape: z.string()
});

export const AiAnswerReadinessSchema = AiAnswerReadinessBaseSchema.extend({
  structures: z.array(AnswerStructureSignalSchema)
});

export const AiCitationSummarySchema = z.object({
  domain: z.string(),
  auditedUrl: z.string(),
  aiCitationScore: z.number().min(0).max(100),
  verdict: CitationVerdictSchema,
  oneSentenceDiagnosis: z.string(),
  highestPriorityGap: z.string()
});

export const AiCitationGapSchema = z.object({
  priority: PrioritySchema,
  area: z.string(),
  evidence: z.string(),
  recommendation: z.string(),
  expectedImpact: z.string()
});

export const AiCitationAnalysisSchema = z.object({
  summary: AiCitationSummarySchema,
  aiAnswerReadiness: AiAnswerReadinessBaseSchema,
  aiCitationGaps: z.array(AiCitationGapSchema)
});

export const GeoAnalysisSchema = z.object({
  summary: AiCitationSummarySchema,
  checks: CrawlChecksSchema,
  aiAnswerReadiness: AiAnswerReadinessSchema,
  aiCitationGaps: z.array(AiCitationGapSchema)
});

export type GeoAnalysis = z.infer<typeof GeoAnalysisSchema>;
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;
export type CrawlChecks = z.infer<typeof CrawlChecksSchema>;
export type AnswerStructureSignal = z.infer<typeof AnswerStructureSignalSchema>;
export type AiCitationAnalysis = z.infer<typeof AiCitationAnalysisSchema>;

export type ScannedPage = {
  url: string;
  title: string;
  description: string;
  wordCount: number;
  h1s: string[];
  h2Count: number;
  h3Count: number;
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
