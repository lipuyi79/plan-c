"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Database,
  ExternalLink,
  FileSearch,
  Gauge,
  Layers3,
  Loader2,
  Mail,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  WandSparkles
} from "lucide-react";
import type { AnalyzeApiResponse, GeoAnalysis } from "@/lib/schema";

type Tab = "gaps" | "recommendations" | "queries" | "signals";

const severityLabels = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low"
};

const supportLabels = {
  strong: "Strong",
  partial: "Partial",
  weak: "Weak",
  missing: "Missing"
};

const verdictLabels = {
  ready: "Ready for AI recommendations",
  needs_work: "Needs work",
  high_risk: "High citation risk"
};

const faqGroups = [
  {
    title: "Basic Workflow",
    items: [
      {
        question: "What is a GEO audit, and how is it different from traditional SEO?",
        answer:
          "GEO, or Generative Engine Optimization, focuses on AI answer engines such as ChatGPT and Gemini. Instead of tracking Google rankings, it checks whether your website has the structure, entity clarity, and evidence needed to be cited or recommended inside AI-generated answers."
      },
      {
        question: "How do I use this GEO tool? What is the full workflow?",
        answer:
          "The workflow has four simple steps: enter a website URL, let the system scan the page content and structure, identify GEO citation gaps, and generate practical optimization recommendations you can apply directly."
      },
      {
        question: "Which websites can be scanned? Can it handle stores, blogs, and independent sites?",
        answer:
          "Any publicly accessible webpage can be scanned, including WordPress sites, Shopify stores, company websites, content blogs, and landing pages. You only need a public URL. No plugin installation or domain binding is required."
      },
      {
        question: "How long does a scan take?",
        answer:
          "A single-page scan usually takes 5 to 15 seconds. The tool extracts page copy, structure, and entity signals, then returns a GEO report with optimization suggestions."
      },
      {
        question: "Do I need to verify domain ownership before scanning?",
        answer:
          "No. If the page is publicly accessible, you can enter the URL and scan it immediately. There is no verification or binding process in the MVP."
      },
      {
        question: "Can I scan an entire site, or only one page?",
        answer:
          "The MVP is optimized for precise single-page scans of key pages such as homepages, product pages, and blog posts. This keeps the scan focused, faster, and friendlier to compliance and anti-crawling limits."
      }
    ]
  },
  {
    title: "Scanning Logic and Accuracy",
    items: [
      {
        question: "What content does the tool collect during a scan?",
        answer:
          "The tool collects cleaned page text, page titles, heading hierarchy, meta descriptions, Open Graph tags, structured data, and brand/entity signals while filtering out low-value navigation, ads, footer copy, and popups where possible."
      },
      {
        question: "Can it scan JavaScript-rendered sites such as Shopify or Webflow?",
        answer:
          "Yes. The scanner uses rendered page extraction, which helps capture content from dynamic websites and reduces the chance of empty or incomplete scans."
      },
      {
        question: "Why can the same page receive slightly different scores across scans?",
        answer:
          "AI models and citation logic are dynamic. Small score changes can happen as model behavior, page rendering, or extracted context changes. The report is designed to keep the overall diagnosis and gap analysis stable."
      },
      {
        question: "Will scanning create traffic pressure on my website server?",
        answer:
          "No. The MVP performs lightweight requests for the submitted URL and selected page context. It is not a high-frequency crawler and is designed to minimize load."
      },
      {
        question: "How accurate are the results, and what standards are used?",
        answer:
          "The analysis is based on core GEO dimensions: entity consistency, content structure, brand and domain clarity, completeness of citeable evidence, and the risk of AI hallucination or misattribution."
      },
      {
        question: "Does the tool support multilingual websites?",
        answer:
          "Yes. The tool can analyze major languages, including English and Chinese, making it suitable for international sites and cross-border commerce pages."
      },
      {
        question: "Can it scan password-protected or private pages?",
        answer:
          "No. The MVP only supports publicly accessible pages. Pages behind login, authorization, or private access controls cannot be scanned."
      },
      {
        question: "Why did my scan fail or why could the page not be opened?",
        answer:
          "Common causes include website firewalls, CDN protection, request timeouts, invalid links, robots restrictions, or temporary server errors. Check that the URL is valid and publicly reachable, then try again."
      }
    ]
  },
  {
    title: "GEO Citation Gap Analysis",
    items: [
      {
        question: "What is a GEO citation gap, and what can the tool detect?",
        answer:
          "A citation gap is anything that prevents AI systems from confidently citing your page. The tool looks for issues such as unclear entities, weak structure, missing evidence, missing brand mentions, unsupported claims, poor headings, fragmented content, and hallucination risk."
      },
      {
        question: "Why can a site rank well in SEO but score poorly in GEO?",
        answer:
          "Traditional SEO is built around search rankings and links. GEO is built around model citation logic. A page may rank well in Google but still be hard for AI systems to quote if its claims, structure, and entity signals are weak."
      },
      {
        question: "Can small brands or new sites still improve their GEO visibility?",
        answer:
          "Yes. AI citation is not only about brand size. A smaller brand with clear entities, structured answers, and strong evidence can become easier for AI systems to cite than a larger but poorly structured page."
      },
      {
        question: "Can the tool compare competitor GEO visibility?",
        answer:
          "Competitor comparison is planned for advanced plans. It will help teams compare AI exposure gaps, citation weaknesses, and content opportunities against competing pages."
      },
      {
        question: "Do more GEO gaps mean AI systems are less likely to recommend my site?",
        answer:
          "Generally, yes. The more unresolved gaps a page has, the harder it becomes for ChatGPT, Gemini, and other AI systems to treat it as a trustworthy source."
      },
      {
        question: "Which pages most often have GEO citation gaps?",
        answer:
          "Product pages, sales-heavy landing pages, loosely structured blogs, unsupported marketing copy, and pages with inconsistent brand or entity naming often show the most GEO gaps."
      },
      {
        question: "Can I batch scan multiple pages for GEO gaps?",
        answer:
          "Batch URL scanning is planned for paid plans. It will support multi-page gap statistics and broader site-level GEO health checks."
      },
      {
        question: "Can I export the GEO gap report?",
        answer:
          "CSV and PDF exports are planned for reporting workflows. These exports will include gap details, scoring data, affected pages, and recommended actions."
      }
    ]
  },
  {
    title: "Recommendations and Outcomes",
    items: [
      {
        question: "Can I directly apply the generated recommendations?",
        answer:
          "Yes. Recommendations are designed to be lightweight and practical, covering content rewrites, structure improvements, brand insertion, evidence additions, and heading optimization."
      },
      {
        question: "How long does it take to see AI citation improvements after optimization?",
        answer:
          "After you update the page, AI visibility may improve as models and retrieval systems refresh their knowledge or search indexes. This can take anywhere from a few days to several weeks."
      },
      {
        question: "Can the tool rewrite my website content directly?",
        answer:
          "The MVP generates optimization guidance and example copy. A one-click GEO-compliant rewrite workflow is planned so teams can restructure content while preserving business facts."
      },
      {
        question: "Will my GEO score definitely improve after applying the suggestions?",
        answer:
          "If you fully address the identified gaps, the page should become more structured and citeable. However, no tool can guarantee a specific score or AI mention because model behavior changes over time."
      },
      {
        question: "Will GEO optimization hurt my Google SEO rankings?",
        answer:
          "No. GEO improvements are designed to be compatible with traditional SEO. Clear structure, better evidence, and stronger content quality can support both SEO and AI answer visibility."
      },
      {
        question: "Should I rescan after editing my content?",
        answer:
          "Yes. Rescanning after updates helps verify which gaps were fixed, whether the score improved, and what should be optimized next."
      }
    ]
  },
  {
    title: "Plans, Usage, and Safety",
    items: [
      {
        question: "What is the difference between the free and paid versions?",
        answer:
          "The free version is designed for basic single-page scans, gap detection, and simple recommendations. Paid plans are expected to add batch scanning, competitor comparison, full optimization plans, report exports, and higher-quality GEO content generation."
      },
      {
        question: "Will my scanned URL or website data be leaked or sold?",
        answer:
          "No. Scan data is used to generate the report for the submitted URL. We do not sell user website data. The MVP is designed with data minimization and privacy-conscious storage practices."
      }
    ]
  }
];

const legalSections = [
  {
    title: "Terms of Service",
    body:
      "By using GetRecommendedByAi, you agree to submit only URLs you are legally allowed to analyze. The service provides automated GEO and content recommendations for informational purposes. You may not use the tool for abuse, scraping private systems, bypassing access controls, or violating third-party rights."
  },
  {
    title: "Privacy Policy",
    body:
      "We process submitted URLs and extracted page context to generate GEO reports. If database storage is enabled, scan records may be stored for product improvement and user support. We do not sell submitted website data. Contact us at 15018647951@163.com for privacy questions or deletion requests."
  },
  {
    title: "Refund Policy",
    body:
      "The current MVP does not include paid checkout. If paid plans are introduced later, refund eligibility, billing periods, and cancellation rules will be displayed clearly before purchase and handled according to the policy active at the time of payment."
  },
  {
    title: "Disclaimer",
    body:
      "GEO reports are generated with automated systems and may contain errors or incomplete interpretations. Recommendations do not guarantee rankings, AI citations, traffic growth, revenue, or specific model behavior. You remain responsible for reviewing and applying any changes."
  },
  {
    title: "Cookie Policy",
    body:
      "The MVP uses only essential cookies or storage needed for hosting and product operation unless analytics are enabled later. You can control cookies in your browser settings. If non-essential analytics or marketing cookies are added, the policy will be updated."
  }
];

export default function Home() {
  const [url, setUrl] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("gaps");
  const [result, setResult] = useState<AnalyzeApiResponse | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const scoreTone = useMemo(() => {
    const score = result?.analysis.summary.readinessScore ?? 0;

    if (score >= 70) {
      return "score-good";
    }

    if (score >= 40) {
      return "score-mid";
    }

    return "score-low";
  }, [result]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url,
          language: "en-US"
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Analysis failed.");
      }

      setResult(payload as AnalyzeApiResponse);
      setActiveTab("gaps");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Analysis failed.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <BrandLockup />
        <div className="topbar-meta">
          <a href="#faq">FAQ</a>
          <a href="#legal">Legal</a>
          <a href="mailto:15018647951@163.com">Contact</a>
        </div>
      </header>

      <section className="workspace">
        <aside className="scan-panel" aria-label="GEO scan controls">
          <div className="panel-heading">
            <LogoMark className="panel-logo" />
            <div>
              <h1>GEO Citation Gap Scanner</h1>
              <p>Firecrawl + OpenAI + Supabase</p>
            </div>
          </div>

          <form className="scan-form" onSubmit={handleSubmit}>
            <label htmlFor="url">Website URL</label>
            <div className="url-control">
              <Search size={19} aria-hidden="true" />
              <input
                id="url"
                name="url"
                type="text"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                autoComplete="url"
                required
              />
            </div>
            <button className="primary-button" type="submit" disabled={isLoading}>
              {isLoading ? <Loader2 className="spin" size={19} /> : <WandSparkles size={19} />}
              <span>{isLoading ? "Scanning" : "Start Scan"}</span>
            </button>
          </form>

          {error ? (
            <div className="error-box" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="pipeline" aria-live="polite">
            <PipelineStep active={isLoading} done={Boolean(result)} icon={<Layers3 size={18} />} label="Discover pages" />
            <PipelineStep active={isLoading} done={Boolean(result)} icon={<FileSearch size={18} />} label="Extract content" />
            <PipelineStep active={isLoading} done={Boolean(result)} icon={<Sparkles size={18} />} label="Generate advice" />
            <PipelineStep
              active={isLoading}
              done={Boolean(result?.scan.persisted)}
              icon={<Database size={18} />}
              label="Save report"
            />
          </div>

          {result ? (
            <div className="scan-footnote">
              <span>{result.scan.pageCount} pages</span>
              <span>{Math.round(result.scan.elapsedMs / 1000)} seconds</span>
              <span>{result.scan.persisted ? "Saved" : "Not stored"}</span>
            </div>
          ) : null}
        </aside>

        <section className="results-panel" aria-label="GEO analysis results">
          {!result && !isLoading ? <EmptyState /> : null}
          {isLoading ? <LoadingState /> : null}
          {result ? (
            <>
              <section className="score-section">
                <div className={`score-ring ${scoreTone}`}>
                  <Gauge size={24} />
                  <strong>{Math.round(result.analysis.summary.readinessScore)}</strong>
                  <span>/100</span>
                </div>
                <div className="score-copy">
                  <div className="status-line">
                    <span className={`verdict-pill ${result.analysis.summary.verdict}`}>
                      {verdictLabels[result.analysis.summary.verdict]}
                    </span>
                    <a href={result.scan.siteUrl} target="_blank" rel="noreferrer">
                      {result.analysis.summary.domain || result.scan.siteUrl}
                      <ExternalLink size={15} />
                    </a>
                  </div>
                  <h2>{result.analysis.summary.oneSentenceDiagnosis}</h2>
                  <div className="summary-grid">
                    <SummaryItem label="Brand" value={result.analysis.summary.brandName} />
                    <SummaryItem label="Type" value={result.analysis.summary.detectedBusinessType} />
                    <SummaryItem label="Audience" value={result.analysis.summary.primaryAudience} />
                  </div>
                </div>
              </section>

              <nav className="tabs" aria-label="Result sections">
                <TabButton active={activeTab === "gaps"} icon={<AlertTriangle size={17} />} onClick={() => setActiveTab("gaps")}>
                  Gaps
                </TabButton>
                <TabButton
                  active={activeTab === "recommendations"}
                  icon={<Clipboard size={17} />}
                  onClick={() => setActiveTab("recommendations")}
                >
                  Advice
                </TabButton>
                <TabButton active={activeTab === "queries"} icon={<Target size={17} />} onClick={() => setActiveTab("queries")}>
                  AI Queries
                </TabButton>
                <TabButton
                  active={activeTab === "signals"}
                  icon={<CheckCircle2 size={17} />}
                  onClick={() => setActiveTab("signals")}
                >
                  Signals
                </TabButton>
              </nav>

              {activeTab === "gaps" ? <GapList analysis={result.analysis} /> : null}
              {activeTab === "recommendations" ? <RecommendationList analysis={result.analysis} /> : null}
              {activeTab === "queries" ? <QueryList analysis={result.analysis} /> : null}
              {activeTab === "signals" ? <SignalList analysis={result.analysis} pages={result.scan.pages} /> : null}
            </>
          ) : null}
        </section>
      </section>

      <SiteFooter />
    </main>
  );
}

function LogoMark({ className = "" }: { className?: string }) {
  return <img className={`logo-mark ${className}`} src="/logo.svg" alt="GetRecommendedByAi logo" />;
}

function BrandLockup() {
  return (
    <a className="brand" href="/" aria-label="GetRecommendedByAi home">
      <LogoMark />
      <span>
        <strong>GetRecommendedByAi</strong>
        <small>AI recommendation readiness</small>
      </span>
    </a>
  );
}

function PipelineStep({
  active,
  done,
  icon,
  label
}: {
  active: boolean;
  done: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className={`pipeline-step ${active ? "active" : ""} ${done ? "done" : ""}`}>
      <span>{done ? <CheckCircle2 size={18} /> : icon}</span>
      <strong>{label}</strong>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-visual" aria-hidden="true">
        <LogoMark />
        <span />
        <span />
        <span />
      </div>
      <div>
        <h2>Ready to scan</h2>
        <p>Your report will appear here with citation gaps, recommendations, AI query targets, and technical signals.</p>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <Loader2 className="spin" size={34} />
      <h2>Generating your GEO report</h2>
      <p>Page discovery, content extraction, and structured analysis run in a single scan request.</p>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-item">
      <span>{label}</span>
      <strong>{value || "Unknown"}</strong>
    </div>
  );
}

function TabButton({
  active,
  children,
  icon,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={`tab-button ${active ? "active" : ""}`} type="button" onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

function GapList({ analysis }: { analysis: GeoAnalysis }) {
  return (
    <div className="card-grid">
      {analysis.citationGaps.map((gap) => (
        <article className="result-card" key={`${gap.area}-${gap.severity}`}>
          <div className="card-head">
            <h3>{gap.area}</h3>
            <span className={`severity ${gap.severity}`}>{severityLabels[gap.severity]}</span>
          </div>
          <p>{gap.evidence}</p>
          <div className="callout">
            <strong>Why it matters</strong>
            <span>{gap.whyItMatters}</span>
          </div>
          <TagRow items={gap.affectedPages} />
        </article>
      ))}
    </div>
  );
}

function RecommendationList({ analysis }: { analysis: GeoAnalysis }) {
  return (
    <div className="card-grid">
      {analysis.recommendations.map((recommendation) => (
        <article className="result-card wide" key={`${recommendation.priority}-${recommendation.title}`}>
          <div className="card-head">
            <h3>{recommendation.title}</h3>
            <span className="priority">{recommendation.priority}</span>
          </div>
          <div className="metric-row">
            <span>Impact: {recommendation.impact}</span>
            <span>Effort: {recommendation.effort}</span>
            <span>{recommendation.targetPage}</span>
          </div>
          <p>{recommendation.rationale}</p>
          <ul className="action-list">
            {recommendation.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
          <CopyBlock text={recommendation.exampleCopy} />
          <div className="callout">
            <strong>Success metric</strong>
            <span>{recommendation.successMetric}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function QueryList({ analysis }: { analysis: GeoAnalysis }) {
  return (
    <div className="card-grid">
      {analysis.aiAnswerTargets.map((target) => (
        <article className="result-card" key={target.query}>
          <div className="card-head">
            <h3>{target.query}</h3>
            <span className={`support ${target.currentSupportLevel}`}>{supportLabels[target.currentSupportLevel]}</span>
          </div>
          <p>{target.expectedMention}</p>
          <TagRow items={target.missingEvidence} />
        </article>
      ))}
    </div>
  );
}

function SignalList({ analysis, pages }: { analysis: GeoAnalysis; pages: AnalyzeApiResponse["scan"]["pages"] }) {
  const technicalSignals = Object.entries(analysis.technicalSignals);

  return (
    <div className="signals-layout">
      <section className="signal-block">
        <h3>Content signals</h3>
        <SignalGroup title="Strengths" items={analysis.contentSignals.strengths} />
        <SignalGroup title="Weaknesses" items={analysis.contentSignals.weaknesses} />
        <SignalGroup title="Missing assets" items={analysis.contentSignals.missingArtifacts} />
      </section>

      <section className="signal-block">
        <h3>Technical signals</h3>
        <div className="technical-list">
          {technicalSignals.map(([key, value]) => (
            <div key={key}>
              <span>{signalLabel(key)}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="signal-block">
        <h3>Scanned pages</h3>
        <div className="page-list">
          {pages.map((page) => (
            <a key={page.url} href={page.url} target="_blank" rel="noreferrer">
              <span>{page.title || page.url}</span>
              <small>{page.wordCount} words</small>
            </a>
          ))}
        </div>
      </section>

      <section className="signal-block">
        <h3>Next steps</h3>
        <SignalGroup title="Quick wins" items={analysis.quickWins} />
        <SignalGroup title="Roadmap" items={analysis.nextSteps} />
      </section>
    </div>
  );
}

function SignalGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="signal-group">
      <span>{title}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function TagRow({ items }: { items: string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="tag-row">
      {items.slice(0, 6).map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="copy-block">
      <p>{text}</p>
      <button type="button" onClick={copy} title="Copy example copy" aria-label="Copy example copy">
        {copied ? <CheckCircle2 size={17} /> : <Clipboard size={17} />}
      </button>
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <section className="footer-grid" aria-label="Footer overview">
        <div className="footer-brand">
          <BrandLockup />
          <p>
            Scan a public URL, identify GEO citation gaps, and turn AI recommendation readiness into a clear optimization
            checklist.
          </p>
          <div className="footer-actions">
            <a href="mailto:15018647951@163.com">
              <Mail size={17} />
              15018647951@163.com
            </a>
            <a href="https://x.com/lpy520ow" target="_blank" rel="noreferrer" aria-label="Follow on X">
              <XSocialIcon />
              @lpy520ow
            </a>
          </div>
        </div>

        <nav className="footer-links" aria-label="Footer links">
          <a href="#faq">FAQ</a>
          <a href="#legal">Legal</a>
          <a href="mailto:15018647951@163.com">Support</a>
          <a href="https://getrecommendedbyai.net">getrecommendedbyai.net</a>
        </nav>

        <div className="footer-trust">
          <ShieldCheck size={22} />
          <div>
            <strong>MVP data posture</strong>
            <span>Public URLs only, server-side API keys, and privacy-conscious report storage.</span>
          </div>
        </div>
      </section>

      <section className="footer-section" id="faq">
        <div className="section-heading">
          <span>FAQ</span>
          <h2>GEO scanning questions</h2>
        </div>
        <div className="faq-groups">
          {faqGroups.map((group, groupIndex) => (
            <div className="faq-group" key={group.title}>
              <h3>{group.title}</h3>
              <div className="accordion-grid">
                {group.items.map((item, index) => (
                  <details key={item.question}>
                    <summary>
                      <span>{getFaqNumber(groupIndex, index)}</span>
                      {item.question}
                    </summary>
                    <p>{item.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="footer-section" id="legal">
        <div className="section-heading">
          <span>Legal</span>
          <h2>Policies and notices</h2>
        </div>
        <div className="legal-grid">
          {legalSections.map((section) => (
            <article key={section.title}>
              <h3>{section.title}</h3>
              <p>{section.body}</p>
            </article>
          ))}
        </div>
      </section>

      <div className="footer-bottom">
        <span>Copyright 2026 GetRecommendedByAi. All rights reserved.</span>
        <span>Built for AI SEO and GEO citation readiness.</span>
      </div>
    </footer>
  );
}

function getFaqNumber(groupIndex: number, itemIndex: number) {
  const previousCount = faqGroups
    .slice(0, groupIndex)
    .reduce((total, group) => total + group.items.length, 0);

  return previousCount + itemIndex + 1;
}

function XSocialIcon() {
  return (
    <svg className="x-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M13.87 10.16 21.18 2h-1.73l-6.35 7.08L8.03 2H2.18l7.66 10.7L2.18 22h1.73l6.7-7.48L15.97 22h5.85l-7.95-11.84Zm-2.37 2.65-.78-1.07L4.55 3.25H7.2l4.99 6.86.78 1.07 6.49 8.94h-2.65l-5.31-7.31Z" />
    </svg>
  );
}

function signalLabel(key: string) {
  const labels: Record<string, string> = {
    schemaMarkup: "Schema",
    faqCoverage: "FAQ",
    authorTrust: "Trust",
    freshness: "Freshness",
    crawlability: "Crawlability",
    llmsTxt: "llms.txt",
    sitemapClarity: "Sitemap"
  };

  return labels[key] ?? key;
}
