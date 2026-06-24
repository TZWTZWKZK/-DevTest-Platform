import {
  CATEGORIES_META,
  normalizeIterationAnalysis,
  type IterationAnalysisData,
  type SectionAttachment,
} from "@/lib/iterationAnalysis";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderAttachmentBlock(att: SectionAttachment | null | undefined): string {
  if (!att) return "";
  if (att.kind === "html") {
    const src = escapeHtml(att.payload);
    return `<div class="html-preview-wrap"><div class="file-tag">附件：${escapeHtml(att.fileName)}</div><iframe class="html-preview" sandbox="allow-same-origin" srcdoc="${src}" title="${escapeHtml(att.fileName)}"></iframe></div>`;
  }
  const href = `data:${att.mimeType};base64,${att.payload}`;
  return `<p class="file-tag">附件：<a href="${href}" download="${escapeHtml(att.fileName)}">${escapeHtml(att.fileName)}</a></p>`;
}

function renderTextBlock(text: string): string {
  if (!text.trim()) return `<p class="muted">（空）</p>`;
  return `<div class="text-block">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
}

export function buildIterationAnalysisHtmlReport(
  data: IterationAnalysisData,
  meta: { iterationLabel: string; exportedAt: string },
): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  const briefBlock = `
    <section class="block">
      <h2>简言</h2>
      ${renderTextBlock(data.brief)}
      ${renderAttachmentBlock(data.briefAttachment)}
    </section>`;

  const categoryBlocks = CATEGORIES_META.map((cat) => {
    const sections = data[cat.key].sections
      .map(
        (s) => `
        <article class="sub-block">
          <h3>${escapeHtml(s.title)}</h3>
          ${renderTextBlock(s.content)}
          ${renderAttachmentBlock(s.attachment)}
        </article>`,
      )
      .join("");
    return `
      <section class="block">
        <h2>${escapeHtml(cat.title)}</h2>
        <p class="desc">${escapeHtml(cat.description)}</p>
        ${sections || '<p class="muted">（无子栏目）</p>'}
      </section>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>迭代分析报告 - ${escapeHtml(meta.iterationLabel)}</title>
  <style>
    body { margin: 0; padding: 32px 40px; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #18181b; background: #fafafa; line-height: 1.6; }
    h1 { margin: 0 0 8px; font-size: 1.75rem; }
    .meta { color: #71717a; font-size: 0.875rem; margin-bottom: 28px; }
    .block { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .block h2 { margin: 0 0 12px; font-size: 1.125rem; }
    .desc { margin: 0 0 12px; font-size: 0.8125rem; color: #71717a; }
    .sub-block { border-top: 1px solid #f4f4f5; padding-top: 14px; margin-top: 14px; }
    .sub-block:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }
    .sub-block h3 { margin: 0 0 8px; font-size: 0.9375rem; }
    .text-block { font-size: 0.875rem; color: #3f3f46; white-space: pre-wrap; }
    .muted { color: #a1a1aa; font-size: 0.875rem; }
    .file-tag { font-size: 0.8125rem; color: #52525b; margin: 8px 0; }
    .html-preview-wrap { margin-top: 8px; overflow: visible; }
    .html-preview { width: 100%; border: 1px solid #e4e4e7; border-radius: 8px; background: #fff; overflow: hidden; display: block; }
    @media print { body { background: #fff; } }
  </style>
</head>
<body>
  <h1>迭代分析报告</h1>
  <p class="meta">迭代：${escapeHtml(meta.iterationLabel)} · 导出时间：${escapeHtml(meta.exportedAt)}</p>
  ${briefBlock}
  ${categoryBlocks}
  <script id="iteration-analysis-data" type="application/json">${json}</script>
  <script>
(function () {
  function fitHtmlPreviewIframes() {
    document.querySelectorAll("iframe.html-preview").forEach(function (iframe) {
      var el = iframe;
      var doc = el.contentDocument;
      if (!doc) return;
      var h = Math.max(
        doc.documentElement ? doc.documentElement.scrollHeight : 0,
        doc.body ? doc.body.scrollHeight : 0,
        80
      );
      el.style.height = h + "px";
      el.setAttribute("scrolling", "no");
    });
  }
  window.addEventListener("load", function () {
    fitHtmlPreviewIframes();
    setTimeout(fitHtmlPreviewIframes, 150);
    setTimeout(fitHtmlPreviewIframes, 600);
  });
  document.querySelectorAll("iframe.html-preview").forEach(function (iframe) {
    iframe.addEventListener("load", fitHtmlPreviewIframes);
  });
})();
  </script>
</body>
</html>`;
}

export function parseIterationAnalysisHtmlReport(
  html: string,
): IterationAnalysisData | { error: string } {
  const m = html.match(
    /<script[^>]*id=["']iteration-analysis-data["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!m?.[1]) {
    return { error: "未找到报告数据，请使用本系统导出的 HTML 报告文件。" };
  }
  try {
    const raw = JSON.parse(m[1].trim());
    return normalizeIterationAnalysis(raw);
  } catch {
    return { error: "报告数据格式无效，无法导入。" };
  }
}

export function triggerBlobDownload(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
