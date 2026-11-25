import { describe, expect, it } from "vitest";
import { renderInlineMarkdown, renderMarkdownToHtml, sanitizeUrl } from "../src/runtime/markdown";

describe("OpenScout Zero-Dependency XSS-Safe Markdown Formatter", () => {
  it("renders headings (h1-h4), emphasis, inline code, and protects underscores in agent identifiers", () => {
    const md = [
      "# Report Title",
      "## Section Two",
      "### OpenScout Due-Diligence Report (Mock Mode)",
      "#### Risk Summary",
      "",
      "Lead **scout_front** delegated to *repo_auditor* and `spec_conformance_auditor` with _emphasis_.",
    ].join("\n");

    const html = renderMarkdownToHtml(md);
    expect(html).toContain("<h1>Report Title</h1>");
    expect(html).toContain("<h2>Section Two</h2>");
    expect(html).toContain("<h3>OpenScout Due-Diligence Report (Mock Mode)</h3>");
    expect(html).toContain("<h4>Risk Summary</h4>");
    expect(html).toContain("<strong>scout_front</strong>");
    expect(html).toContain("<em>repo_auditor</em>");
    expect(html).toContain("<code>spec_conformance_auditor</code>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).not.toContain("###");
    expect(html).not.toContain("**");
  });

  it("renders unordered lists, ordered lists, and fenced code blocks", () => {
    const md = [
      "- **repo_auditor**: checked `cognizant-ai-labs/agentic-web`",
      "- **risk_synthesizer**: computed score",
      "",
      "1. Fetch `agent-manifest.json`",
      "2. Validate `front_man`",
      "",
      "```json",
      '{"status": "PASS", "tag": "<script>"}',
      "```",
    ].join("\n");

    const html = renderMarkdownToHtml(md);
    expect(html).toContain("<ul><li><strong>repo_auditor</strong>: checked <code>cognizant-ai-labs/agentic-web</code></li>");
    expect(html).toContain("<ol><li>Fetch <code>agent-manifest.json</code></li><li>Validate <code>front_man</code></li></ol>");
    expect(html).toContain('<pre class="md-pre"><code class="language-json">');
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders Markdown tables inside responsive wrapper with alignment and escaped pipes", () => {
    const md = [
      "| Signal | Status | Grounded Evidence |",
      "|:---|:---:|---:|",
      "| Multi-Agent Delegation | **PASS** | Executed inside browser runtime |",
      "| Pipe Handling | PASS | `a|b` and foo\\|bar |",
    ].join("\n");

    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<div class="md-table-wrap"><table class="md-table">');
    expect(html).toContain("<th>Signal</th>");
    expect(html).toContain('<th style="text-align:center">Status</th>');
    expect(html).toContain('<th style="text-align:right">Grounded Evidence</th>');
    expect(html).toContain('<td style="text-align:center"><strong>PASS</strong></td>');
    expect(html).toContain("<code>a|b</code> and foo|bar");
    expect(html).not.toContain("|---|");
  });

  it("neutralizes XSS payloads, raw HTML tags, and unsafe javascript:/data: links", () => {
    const xss = [
      '<img src=x onerror="alert(1)">',
      "Click [evil](javascript:alert(1)) or [data](data:text/html,<script>alert(1)</script>)",
      "Safe [GitHub](https://github.com/cognizant-ai-labs/agentic-web)",
    ].join("\n\n");

    const html = renderMarkdownToHtml(xss);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('<a href="https://github.com/cognizant-ai-labs/agentic-web" target="_blank" rel="noopener noreferrer">GitHub</a>');
    expect(sanitizeUrl("  JaVaScRiPt:alert(1)")).toBeNull();
    expect(sanitizeUrl("https://openscout.test/node")).toBe("https://openscout.test/node");
    expect(renderInlineMarkdown("`<script>alert(1)</script>`")).toBe("<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>");
  });
});
