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
  Globe2,
  Layers3,
  Loader2,
  Search,
  Sparkles,
  Target,
  WandSparkles
} from "lucide-react";
import type { AnalyzeApiResponse, GeoAnalysis } from "@/lib/schema";

type Tab = "gaps" | "recommendations" | "queries" | "signals";

const severityLabels = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低"
};

const supportLabels = {
  strong: "强",
  partial: "部分",
  weak: "弱",
  missing: "缺失"
};

const verdictLabels = {
  ready: "可进入推荐池",
  needs_work: "需要补强",
  high_risk: "引用风险高"
};

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
          language: "zh-CN"
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "分析失败");
      }

      setResult(payload as AnalyzeApiResponse);
      setActiveTab("gaps");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "分析失败");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="GetRecommendedByAi">
          <span className="brand-mark">
            <Sparkles size={20} strokeWidth={2.3} />
          </span>
          <span>
            <strong>GetRecommendedByAi</strong>
            <small>GEO MVP</small>
          </span>
        </a>
        <div className="topbar-meta">
          <span>getrecommendedbyai.net</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="scan-panel" aria-label="GEO scan controls">
          <div className="panel-heading">
            <div className="panel-icon">
              <Globe2 size={22} />
            </div>
            <div>
              <h1>GEO 引用缺口扫描</h1>
              <p>Firecrawl + OpenAI + Supabase</p>
            </div>
          </div>

          <form className="scan-form" onSubmit={handleSubmit}>
            <label htmlFor="url">网址</label>
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
              <span>{isLoading ? "扫描中" : "开始扫描"}</span>
            </button>
          </form>

          {error ? (
            <div className="error-box" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="pipeline" aria-live="polite">
            <PipelineStep active={isLoading} done={Boolean(result)} icon={<Layers3 size={18} />} label="发现页面" />
            <PipelineStep active={isLoading} done={Boolean(result)} icon={<FileSearch size={18} />} label="提取内容" />
            <PipelineStep active={isLoading} done={Boolean(result)} icon={<Sparkles size={18} />} label="生成建议" />
            <PipelineStep
              active={isLoading}
              done={Boolean(result?.scan.persisted)}
              icon={<Database size={18} />}
              label="保存记录"
            />
          </div>

          {result ? (
            <div className="scan-footnote">
              <span>{result.scan.pageCount} 个页面</span>
              <span>{Math.round(result.scan.elapsedMs / 1000)} 秒</span>
              <span>{result.scan.persisted ? "已保存" : "未写入数据库"}</span>
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
                    <SummaryItem label="品牌" value={result.analysis.summary.brandName} />
                    <SummaryItem label="类型" value={result.analysis.summary.detectedBusinessType} />
                    <SummaryItem label="受众" value={result.analysis.summary.primaryAudience} />
                  </div>
                </div>
              </section>

              <nav className="tabs" aria-label="Result sections">
                <TabButton active={activeTab === "gaps"} icon={<AlertTriangle size={17} />} onClick={() => setActiveTab("gaps")}>
                  缺口
                </TabButton>
                <TabButton
                  active={activeTab === "recommendations"}
                  icon={<Clipboard size={17} />}
                  onClick={() => setActiveTab("recommendations")}
                >
                  建议
                </TabButton>
                <TabButton active={activeTab === "queries"} icon={<Target size={17} />} onClick={() => setActiveTab("queries")}>
                  问法
                </TabButton>
                <TabButton
                  active={activeTab === "signals"}
                  icon={<CheckCircle2 size={17} />}
                  onClick={() => setActiveTab("signals")}
                >
                  信号
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
    </main>
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
        <span />
        <span />
        <span />
        <span />
      </div>
      <div>
        <h2>等待扫描</h2>
        <p>结果会在这里显示为缺口、建议、AI 问法和站点信号。</p>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <Loader2 className="spin" size={34} />
      <h2>正在生成 GEO 报告</h2>
      <p>站点发现、页面提取和结构化分析会在同一次请求中完成。</p>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-item">
      <span>{label}</span>
      <strong>{value || "未知"}</strong>
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
            <strong>影响</strong>
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
            <span>影响: {recommendation.impact}</span>
            <span>工作量: {recommendation.effort}</span>
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
            <strong>衡量</strong>
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
        <h3>内容信号</h3>
        <SignalGroup title="优势" items={analysis.contentSignals.strengths} />
        <SignalGroup title="弱点" items={analysis.contentSignals.weaknesses} />
        <SignalGroup title="缺失资产" items={analysis.contentSignals.missingArtifacts} />
      </section>

      <section className="signal-block">
        <h3>技术信号</h3>
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
        <h3>已扫描页面</h3>
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
        <h3>下一步</h3>
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
      <button type="button" onClick={copy} title="复制示例文案" aria-label="复制示例文案">
        {copied ? <CheckCircle2 size={17} /> : <Clipboard size={17} />}
      </button>
    </div>
  );
}

function signalLabel(key: string) {
  const labels: Record<string, string> = {
    schemaMarkup: "Schema",
    faqCoverage: "FAQ",
    authorTrust: "信任",
    freshness: "新鲜度",
    crawlability: "可抓取",
    llmsTxt: "llms.txt",
    sitemapClarity: "Sitemap"
  };

  return labels[key] ?? key;
}

