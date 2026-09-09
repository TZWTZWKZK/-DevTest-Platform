export type SectionAttachment = {
  fileName: string;
  mimeType: string;
  kind: "html" | "binary";
  payload: string;
};

export type AnalysisSection = {
  id: string;
  title: string;
  content: string;
  fixed?: boolean;
  attachment?: SectionAttachment | null;
};

export type IterationAnalysisCategory = {
  sections: AnalysisSection[];
};

export type IterationAnalysisData = {
  brief: string;
  briefAttachment?: SectionAttachment | null;
  processOptimization: IterationAnalysisCategory;
  toolImprovement: IterationAnalysisCategory;
  qualityImprovement: IterationAnalysisCategory;
};

export type CategoryKey = keyof Omit<
  IterationAnalysisData,
  "brief" | "briefAttachment"
>;

export const CATEGORIES_META: {
  key: CategoryKey;
  title: string;
  description: string;
}[] = [
  {
    key: "processOptimization",
    title: "研发流程优化（问题来源）",
    description: "含 5 个固定子栏目，可追加自定义子栏目",
  },
  {
    key: "toolImprovement",
    title: "工具改进（提高处理问题速度）",
    description: "可添加多个子栏目",
  },
  {
    key: "qualityImprovement",
    title: "质量提升（意识/规避问题）",
    description: "可添加多个子栏目",
  },
];

export const PROCESS_FIXED_SECTIONS: readonly AnalysisSection[] = [
  { id: "process-fixed-1", title: "1.需求/设计阶段", content: "", fixed: true },
  { id: "process-fixed-2", title: "2.开发阶段", content: "", fixed: true },
  { id: "process-fixed-3", title: "3.需求转测阶段", content: "", fixed: true },
  { id: "process-fixed-4", title: "4.测试阶段", content: "", fixed: true },
  { id: "process-fixed-5", title: "5.项目收尾", content: "", fixed: true },
] as const;

export const MAX_ATTACHMENT_BYTES = 1_500_000;

function parseAttachment(raw: unknown): SectionAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const fileName = String(o.fileName ?? "").trim();
  const payload = String(o.payload ?? "");
  const kind = o.kind === "html" ? "html" : o.kind === "binary" ? "binary" : null;
  if (!fileName || !payload || !kind) return null;
  return {
    fileName,
    mimeType: String(o.mimeType ?? ""),
    kind,
    payload,
  };
}

function parseSection(row: Record<string, unknown>): AnalysisSection {
  return {
    id: String(row.id ?? "").trim() || crypto.randomUUID(),
    title: String(row.title ?? "").trim() || "未命名",
    content: String(row.content ?? ""),
    fixed: row.fixed === true ? true : undefined,
    attachment: parseAttachment(row.attachment),
  };
}

function mergeProcessSections(saved: AnalysisSection[]): AnalysisSection[] {
  const custom = saved.filter((s) => !s.fixed);
  return [
    ...PROCESS_FIXED_SECTIONS.map((fixed) => {
      const hit = saved.find((s) => s.id === fixed.id);
      return {
        ...fixed,
        content: hit?.content ?? "",
        attachment: hit?.attachment ?? null,
      };
    }),
    ...custom,
  ];
}

export function createEmptyIterationAnalysis(): IterationAnalysisData {
  return {
    brief: "",
    briefAttachment: null,
    processOptimization: {
      sections: PROCESS_FIXED_SECTIONS.map((s) => ({ ...s })),
    },
    toolImprovement: { sections: [] },
    qualityImprovement: { sections: [] },
  };
}

export function normalizeIterationAnalysis(
  raw: unknown,
): IterationAnalysisData {
  const base = createEmptyIterationAnalysis();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;

  const pick = (key: CategoryKey) => {
    const cat = o[key];
    if (!cat || typeof cat !== "object") return base[key];
    const sections = (cat as { sections?: unknown }).sections;
    if (!Array.isArray(sections)) return base[key];
    const parsed = sections
      .filter((s) => s && typeof s === "object")
      .map((s) => parseSection(s as Record<string, unknown>));
    if (key === "processOptimization") {
      return { sections: mergeProcessSections(parsed) };
    }
    return { sections: parsed };
  };

  return {
    brief: typeof o.brief === "string" ? o.brief : String(o.brief ?? ""),
    briefAttachment: parseAttachment(o.briefAttachment),
    processOptimization: pick("processOptimization"),
    toolImprovement: pick("toolImprovement"),
    qualityImprovement: pick("qualityImprovement"),
  };
}

export function newCustomSection(title: string): AnalysisSection {
  return {
    id: `custom-${crypto.randomUUID()}`,
    title: title.trim(),
    content: "",
    attachment: null,
  };
}

export function isHtmlFile(file: File): boolean {
  const n = file.name.toLowerCase();
  return (
    n.endsWith(".html") ||
    n.endsWith(".htm") ||
    file.type === "text/html"
  );
}

export async function readFileAsAttachment(
  file: File,
): Promise<SectionAttachment | { error: string }> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { error: `文件过大（上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB）` };
  }
  if (isHtmlFile(file)) {
    const payload = await file.text();
    return {
      fileName: file.name,
      mimeType: file.type || "text/html",
      kind: "html",
      payload,
    };
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    kind: "binary",
    payload: btoa(binary),
  };
}
