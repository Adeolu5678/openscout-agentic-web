const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export function sanitizeUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Strip ASCII control characters and whitespace before checking protocol.
  const normalized = trimmed.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("#")
  ) {
    return trimmed;
  }

  return null;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";
  let inCode = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

type CellAlign = "left" | "center" | "right";

function parseTableSeparator(line: string): CellAlign[] | null {
  if (!line.includes("|") && !/^:?-+:?$/.test(line.trim())) {
    return null;
  }
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;

  const alignments: CellAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) {
      return null;
    }
    if (cell.startsWith(":") && cell.endsWith(":")) {
      alignments.push("center");
    } else if (cell.endsWith(":")) {
      alignments.push("right");
    } else {
      alignments.push("left");
    }
  }
  return alignments;
}

function formatEmphasis(escaped: string): string {
  let out = escaped;
  out = out.replace(/\*\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(>])__([^\s_](?:[^_\n]*?[^\s_])?)__(?=$|[\s).,!?:;<])/g, "$1<strong>$2</strong>");
  out = out.replace(/\*([^\s*](?:[^*\n]*?[^\s*])?)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[\s(>])_([^\s_](?:[^_\n]*?[^\s_])?)_(?=$|[\s).,!?:;<])/g, "$1<em>$2</em>");
  return out;
}

export function renderInlineMarkdown(raw: string): string {
  const codeTokens: string[] = [];
  const linkTokens: string[] = [];

  // 1. Protect inline code spans before escaping or formatting emphasis.
  const withCodePlaceholders = raw.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  // 2. Escape all HTML characters so raw tags are neutralized.
  let out = escapeHtml(withCodePlaceholders);

  // 3. Extract markdown links [label](url) with safe URL validation.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const decodedUrl = url
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    const safe = sanitizeUrl(decodedUrl);
    const renderedLabel = formatEmphasis(label);
    const idx = linkTokens.length;
    if (safe) {
      linkTokens.push(
        `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${renderedLabel}</a>`
      );
    } else {
      linkTokens.push(renderedLabel);
    }
    return `\u0000LINK_${idx}\u0000`;
  });

  // 4. Format bold & italic outside links and code spans.
  out = formatEmphasis(out);

  // 5. Restore protected link and inline code HTML tokens.
  out = out.replace(/\u0000LINK_(\d+)\u0000/g, (_m, i: string) => linkTokens[Number(i)] ?? "");
  out = out.replace(/\u0000CODE_(\d+)\u0000/g, (_m, i: string) => codeTokens[Number(i)] ?? "");

  return out;
}

function isBlockStarter(lines: string[], index: number): boolean {
  const line = lines[index];
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return true;
  if (/^>\s?/.test(trimmed)) return true;
  if (/^\s*[-*+]\s+/.test(line)) return true;
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (
    line.includes("|") &&
    index + 1 < lines.length &&
    parseTableSeparator(lines[index + 1]) !== null
  ) {
    return true;
  }
  return false;
}

export function renderMarkdownToHtml(markdown: string): string {
  const normalized = String(markdown ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code blocks
    const fenceMatch = trimmed.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1];
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing fence
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      blocks.push(`<pre class="md-pre"><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings (h1-h4, clamping h5-h6 to h4 for clean chat hierarchy)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      blocks.push("<hr />");
      i += 1;
      continue;
    }

    // Markdown table
    if (line.includes("|") && i + 1 < lines.length) {
      const alignments = parseTableSeparator(lines[i + 1]);
      if (alignments !== null) {
        const headers = splitTableRow(line);
        const colCount = Math.max(headers.length, alignments.length);
        i += 2;

        const bodyRows: string[][] = [];
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          lines[i].includes("|") &&
          !/^```/.test(lines[i].trim()) &&
          !/^#{1,6}\s+/.test(lines[i].trim())
        ) {
          bodyRows.push(splitTableRow(lines[i]));
          i += 1;
        }

        const ths = Array.from({ length: colCount }, (_, colIdx) => {
          const align = alignments[colIdx] ?? "left";
          const attr = align !== "left" ? ` style="text-align:${align}"` : "";
          return `<th${attr}>${renderInlineMarkdown(headers[colIdx] ?? "")}</th>`;
        }).join("");

        const trs = bodyRows
          .map((row) => {
            const tds = Array.from({ length: colCount }, (_, colIdx) => {
              const align = alignments[colIdx] ?? "left";
              const attr = align !== "left" ? ` style="text-align:${align}"` : "";
              return `<td${attr}>${renderInlineMarkdown(row[colIdx] ?? "")}</td>`;
            }).join("");
            return `<tr>${tds}</tr>`;
          })
          .join("");

        blocks.push(
          `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`
        );
        continue;
      }
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${renderMarkdownToHtml(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*+]\s+(.+)$/);
        if (!m) break;
        items.push(`<li>${renderInlineMarkdown(m[1])}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+\.\s+(.+)$/);
        if (!m) break;
        items.push(`<li>${renderInlineMarkdown(m[1])}</li>`);
        i += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]);
      i += 1;
    }
    if (paraLines.length > 0) {
      const htmlLines = paraLines.map((pLine, idx) => {
        const hasHardBreak = /\s{2,}$/.test(pLine) && idx < paraLines.length - 1;
        const rendered = renderInlineMarkdown(pLine.trimEnd());
        return hasHardBreak ? `${rendered}<br />` : rendered;
      });
      blocks.push(`<p>${htmlLines.join(" ")}</p>`);
    } else {
      // Fallback guard to guarantee forward progress
      blocks.push(`<p>${renderInlineMarkdown(line)}</p>`);
      i += 1;
    }
  }

  return blocks.join("\n");
}
