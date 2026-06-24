"use client";

import type { DefectStatus, TestCaseStatus } from "@prisma/client";
import { searchDefectLinkOptions, type DefectLinkOption } from "@/app/actions/defects";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  bulkDeleteTestCases,
  bulkMoveTestCases,
  bulkUpdateTestCasesMeta,
  countTestCasesByFolderSubtree,
  createFolder,
  deleteFolder,
  deleteTestCase,
  getTestCaseFull,
  getTestCaseOpLogs,
  getTestCasesExportRows,
  linkDefectsToTestCaseBatch,
  listDefectsLinkedToTestCase,
  listDeletedTestCasesArchive,
  listFoldersFlat,
  listTestCasesInFolder,
  moveTestCaseFolder,
  renameFolder,
  reorderTestCaseFolderSiblings,
  restoreTestCasesFromArchive,
  saveTestCase,
  unlinkDefectFromTestCase,
  unlinkDefectsFromTestCaseBatch,
  type DefectLinkedToCaseRow,
  type TestCaseFolderFlat,
  type TestCaseListItem,
  type TestCaseOpLogRow,
  type TestCaseExportRow,
} from "@/app/actions/test-cases";
import { bulkImportDesignsToTestCases } from "@/app/actions/test-design";
import {
  addExecutionTaskCaseExecRecord,
  getGlobalIterationProductPreference,
  getGlobalTestCaseExecResultHeightPreference,
  getGlobalTestCaseSidebarPreference,
  getExecutionTaskCaseResult,
  listDeletedTestCaseExecRecords,
  listExecutionTaskCaseExecRecords,
  listTestCaseExecRecords,
  restoreTestCaseExecRecordsFromArchive,
  saveGlobalTestCaseExecResultHeightPreference,
  saveGlobalIterationProductPreference,
  saveGlobalTestCaseSidebarPreference,
  saveExecutionTaskCaseResult,
  type DeletedTestCaseExecRecordRow,
  type ExecutionTaskCaseExecRecordDTO,
} from "@/app/actions/executions";
import { listIterationCodeOptions } from "@/app/actions/iterations";
import { listProductOptions, type ProductOption } from "@/app/actions/products";
import {
  caseLevelToFormValue,
  formatCaseLevelDisplay,
  parseCaseLevelOrNull,
} from "@/lib/case-level";
import {
  collectDescendantFolderIds,
  folderPathFromFlat,
} from "@/lib/folder-path";
import {
  testCaseStatusBadgeClass,
  testCaseStatusLabel,
  testCaseStatusOptions,
  testCaseStatusSelectOptionStyle,
} from "@/lib/test-labels";
import { buildTree, type TreeNode } from "@/lib/tree";
import {
  COLUMN_LABELS,
  DEFAULT_TEST_CASE_EXPORT_FIELDS,
  parseStoredTestCaseExportFields,
  saveStoredTestCaseExportFields,
  TEST_CASE_EXPORT_COLUMN_KEYS,
  TEST_CASE_EXPORT_COLUMN_LABELS,
  type DataColumnKey,
  type TestCaseExportColumnKey,
  useTestCaseListColumns,
} from "@/hooks/useTestCaseListColumns";
import { CaseLevelSelect } from "@/components/CaseLevelSelect";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import { TableColumnResizeHandle } from "@/components/TableColumnResizeHandle";
import { usePagination } from "@/hooks/usePagination";
import { useRowCheckboxBrushByIds } from "@/hooks/useRowCheckboxBrushByIds";

/** 与测试设计「批量导入到用例库」共用 */
const PENDING_TEST_DESIGN_IMPORT_STORAGE = "pm-pending-test-design-import";

/** 拖到目录树顶部「移到顶层」占位 id（非真实文件夹） */
const FOLDER_TREE_ROOT_DROP = "__folder_tree_root_drop__";

/** 同级目录 id 列表：将 activeId 移动到 overId 的位置 */
function reorderSiblingFolderIds(
  ids: string[],
  activeId: string,
  overId: string,
): string[] {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

type FolderNode = TreeNode<TestCaseFolderFlat>;

const DEPTH_ACCENTS = [
  "border-l-violet-500",
  "border-l-blue-500",
  "border-l-teal-500",
  "border-l-amber-500",
];

type FolderMenuState = { folderId: string; x: number; y: number };
type CaseMenuState = { caseId: string; title: string; x: number; y: number };
type FolderNameModalState =
  | null
  | { mode: "newChild"; parentId: string }
  | { mode: "rename"; folderId: string; initial: string }
  | { mode: "newRoot" };

const defectModalStatusLabel: Record<DefectStatus, string> = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  TESTING: "测试",
  CLOSED: "已关闭",
  REOPENED: "重开",
};

const defectModalStatusBadge: Record<DefectStatus, string> = {
  UNASSIGNED: "border-red-500/80 bg-red-50 text-red-800",
  IN_DEVELOPMENT: "border-amber-500/80 bg-amber-50 text-amber-900",
  TESTING: "border-emerald-500/80 bg-emerald-50 text-emerald-800",
  CLOSED: "border-zinc-400 bg-zinc-100 text-zinc-600",
  REOPENED: "border-orange-500/80 bg-orange-50 text-orange-800",
};

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function clampMenuPosition(x: number, y: number, menuW: number, menuH: number) {
  const pad = 8;
  const maxX = typeof window !== "undefined" ? window.innerWidth - menuW - pad : x;
  const maxY = typeof window !== "undefined" ? window.innerHeight - menuH - pad : y;
  return {
    x: Math.max(pad, Math.min(x, maxX)),
    y: Math.max(pad, Math.min(y, maxY)),
  };
}

const DEFAULT_ADV_FILTER = {
  status: "" as TestCaseStatus | "",
  priorityText: "",
  maintainer: "",
  submitter: "",
  folderPathContains: "",
  createdFrom: "",
  createdTo: "",
  updatedFrom: "",
  updatedTo: "",
};
const MAX_PASTED_IMAGE_BYTES = 1_000_000;
const PASTE_IMAGE_SCALE_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4] as const;
const EXEC_RESULT_TEXTAREA_MIN_HEIGHT = 120;
const EXEC_RESULT_TEXTAREA_MAX_HEIGHT = 600;

function clampExecResultHeight(v: number): number {
  if (!Number.isFinite(v)) return EXEC_RESULT_TEXTAREA_MIN_HEIGHT;
  return Math.max(
    EXEC_RESULT_TEXTAREA_MIN_HEIGHT,
    Math.min(EXEC_RESULT_TEXTAREA_MAX_HEIGHT, Math.round(v)),
  );
}

function dayBoundaryMs(isoDate: string, endOfDay: boolean): number | null {
  if (!isoDate) return null;
  const d = new Date(
    endOfDay ? `${isoDate}T23:59:59.999` : `${isoDate}T00:00:00`,
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function inSelectableDateRange(
  iso: string | null | undefined,
  fromMs: number | null,
  toMs: number | null,
): boolean {
  if (fromMs === null && toMs === null) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (fromMs !== null && t < fromMs) return false;
  if (toMs !== null && t > toMs) return false;
  return true;
}

function csvEscapeCell(val: string): string {
  const s = String(val).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildTestCaseExportCsv(
  rows: TestCaseExportRow[],
  fields: readonly TestCaseExportColumnKey[],
): string {
  const headerLine = fields
    .map((k) => csvEscapeCell(TEST_CASE_EXPORT_COLUMN_LABELS[k]))
    .join(",");
  const bodyLines = rows.map((row) =>
    fields.map((k) => csvEscapeCell(row[k] ?? "")).join(","),
  );
  return `\uFEFF${[headerLine, ...bodyLines].join("\r\n")}`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

async function decodeImageForCanvas(file: File): Promise<{
  width: number;
  height: number;
  draw: (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) => void;
  release: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file);
    return {
      width: bmp.width,
      height: bmp.height,
      draw: (ctx, width, height) => ctx.drawImage(bmp, 0, 0, width, height),
      release: () => bmp.close(),
    };
  }

  const src = await blobToDataUrl(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("image decode failed"));
    i.src = src;
  });
  return {
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    draw: (ctx, width, height) => ctx.drawImage(img, 0, 0, width, height),
    release: () => {
      img.src = "";
    },
  };
}

async function normalizePastedImagePng(
  file: File,
  maxBytes = MAX_PASTED_IMAGE_BYTES,
): Promise<{ dataUrl: string; compressed: boolean } | null> {
  if (file.size <= maxBytes) {
    return { dataUrl: await blobToDataUrl(file), compressed: false };
  }
  const decoded = await decodeImageForCanvas(file);
  try {
    for (const scale of PASTE_IMAGE_SCALE_STEPS) {
      const width = Math.max(1, Math.floor(decoded.width * scale));
      const height = Math.max(1, Math.floor(decoded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      decoded.draw(ctx, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) continue;
      if (blob.size <= maxBytes) {
        return { dataUrl: await blobToDataUrl(blob), compressed: true };
      }
    }
    return null;
  } finally {
    decoded.release();
  }
}

function CaseListDataCell({
  col,
  c,
}: {
  col: DataColumnKey;
  c: TestCaseListItem;
}) {
  switch (col) {
    case "caseNo":
      return (
        <span className="block truncate font-mono text-xs italic text-zinc-500 tabular-nums">
          {c.caseNo}
        </span>
      );
    case "title":
      return <span className="block truncate text-zinc-800">{c.title}</span>;
    case "folderPath":
      return (
        <div className="min-w-0">
          <span
            className="line-clamp-2 text-zinc-600"
            title={c.folderPath}
          >
            {c.folderPath}
          </span>
          {!c.isDirectInSelection && (
            <span className="ml-0.5 inline-block rounded bg-amber-100 px-1 text-[10px] leading-tight text-amber-900">
              子目录
            </span>
          )}
        </div>
      );
    case "status":
      return (
        <span
          className={[
            "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium",
            c.status
              ? testCaseStatusBadgeClass[c.status]
              : "border-zinc-200 bg-zinc-50 text-zinc-600",
          ].join(" ")}
        >
          <span className="truncate">
            {c.status ? testCaseStatusLabel[c.status] : "—"}
          </span>
        </span>
      );
    case "priority": {
      const t = formatCaseLevelDisplay(c.priority);
      return (
        <span className="block truncate tabular-nums text-zinc-600">
          {t || ""}
        </span>
      );
    }
    case "maintainer":
      return (
        <span className="block truncate text-zinc-600">
          {c.maintainer ?? "—"}
        </span>
      );
    case "submitter":
      return (
        <span className="block truncate text-zinc-600">
          {c.submitter ?? "—"}
        </span>
      );
    case "createdAt":
      return (
        <span className="block truncate tabular-nums text-zinc-600">
          {formatTs(c.createdAt)}
        </span>
      );
    case "updatedAt":
      return (
        <span className="block truncate tabular-nums text-zinc-600">
          {formatTs(c.updatedAt)}
        </span>
      );
    default:
      return null;
  }
}

/** 用例库左侧栏：「搜索用例」区默认高度（px）；目录树与其之间可拖动分隔条调整 */
const FOLDER_SEARCH_FOOTER_DEFAULT_H = 148;
/** 顶部「目录说明 + 筛选 + 导入提示」区默认高度（px）；下沿拖动可调，超出部分在区内滚动 */
const FOLDER_UPPER_PANE_DEFAULT_H = 300;
const FOLDER_UPPER_PANE_MIN_H = 100;

export function TestCaseLibraryClient({
  initialFolders,
  embedMode = false,
  embedProductId = null,
  openCaseId = null,
  onEmbedClose,
  onEmbedSaved,
  executionTaskId = null,
}: {
  initialFolders: TestCaseFolderFlat[];
  embedMode?: boolean;
  /** 嵌入执行任务页时锁定为迭代所属产品，目录树与该产品的用例库一致 */
  embedProductId?: string | null;
  openCaseId?: string | null;
  onEmbedClose?: () => void;
  onEmbedSaved?: () => void;
  executionTaskId?: string | null;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const deepCaseId = embedMode ? null : searchParams.get("case");
  const designImportFlag = embedMode ? null : searchParams.get("designImport");

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => {
    const roots = buildTree(initialFolders);
    return roots[0]?.id ?? null;
  });
  const [iterationCode, setIterationCode] = useState<string>("");
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productId, setProductId] = useState("");
  const effectiveProductId = useMemo(() => {
    if (embedMode) return (embedProductId ?? "").trim();
    return productId.trim();
  }, [embedMode, embedProductId, productId]);
  const productPrefHydratedRef = useRef(false);
  const [iterationOptions, setIterationOptions] = useState<
    { code: string; label: string; productId?: string | null }[]
  >([{ code: "", label: "baseline（全部迭代）", productId: null }]);
  const [cases, setCases] = useState<TestCaseListItem[]>([]);
  const [loadingCases, setLoadingCases] = useState(false);
  const [folders, setFolders] = useState(initialFolders);
  const [folderSubtreeCounts, setFolderSubtreeCounts] = useState<
    Record<string, number>
  >({});
  const [folderDragId, setFolderDragId] = useState<string | null>(null);
  const [folderDragOverId, setFolderDragOverId] = useState<string | null>(null);
  /** 当前悬停行允许的投放含义（用于描边颜色）；同级时 Ctrl=仅排序，否则=放入其下 */
  const [folderDropMode, setFolderDropMode] = useState<
    "nest" | "reorder" | "invalid" | null
  >(null);
  const [err, setErr] = useState<string | null>(null);

  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [caseMenu, setCaseMenu] = useState<CaseMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuDims = useRef({ w: 168, h: 200 });
  /** 嵌入详情页时：防止异步 openEdit 晚于「关闭/切换用例」后仍弹窗 */
  const embedOpenCaseIdRef = useRef<string | null>(openCaseId ?? null);
  embedOpenCaseIdRef.current = openCaseId ?? null;

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const [caseNo, setCaseNo] = useState("");
  const [title, setTitle] = useState("");
  const [testPlan, setTestPlan] = useState("");
  const [folderId, setFolderId] = useState("");
  const [priority, setPriority] = useState<string>("");
  const [maintainer, setMaintainer] = useState("");
  const [status, setStatus] = useState<TestCaseStatus | "">("");
  const [precondition, setPrecondition] = useState("");
  const [operationSteps, setOperationSteps] = useState("");
  const [caseActualResult, setCaseActualResult] = useState("");
  const [caseRemark, setCaseRemark] = useState("");
  const [submitter, setSubmitter] = useState("");
  /** 编辑时创建时间 ISO（与缺陷弹窗抬头一致，用于展示） */
  const [caseCreatedAtIso, setCaseCreatedAtIso] = useState<string | null>(null);
  /** 编辑时修改时间 ISO（用于展示） */
  const [caseUpdatedAtIso, setCaseUpdatedAtIso] = useState<string | null>(null);
  /** 执行任务内的执行结果（仅嵌入模式可用） */
  const [execResult, setExecResult] = useState("");
  const [execResultUpdatedIso, setExecResultUpdatedIso] = useState<string | null>(null);
  const [execResultTextareaHeight, setExecResultTextareaHeight] = useState(
    EXEC_RESULT_TEXTAREA_MIN_HEIGHT,
  );
  const [execResultTextareaPrefReady, setExecResultTextareaPrefReady] = useState(false);
  const execRunStatusAtOpen = useRef<TestCaseStatus>("BLOCKED");
  const [execRunImages, setExecRunImages] = useState<Array<{ id: string; dataUrl: string }>>(
    [],
  );
  const [execRunImageOpen, setExecRunImageOpen] = useState<string | null>(null);
  const [execRecordDetailOpen, setExecRecordDetailOpen] = useState<{
    executedAt: string;
    status: TestCaseStatus;
    executor: string | null;
    result: string | null;
    images: unknown | null;
    note: string | null;
    executionTaskTitle?: string | null;
  } | null>(null);
  const [caseModalTab, setCaseModalTab] = useState<
    "basic" | "defects" | "execRuns" | "ops"
  >("basic");
  const [execRecords, setExecRecords] = useState<ExecutionTaskCaseExecRecordDTO[]>(
    [],
  );
  // 执行记录通过“保存”自动写入，不在此处单独新增
  const [allExecRecords, setAllExecRecords] = useState<
    Array<{
      id: string;
      executedAt: string;
      status: TestCaseStatus;
      executor: string | null;
      result: string | null;
      images: unknown | null;
      note: string | null;
      executionTaskId: string;
      executionTaskTitle: string | null;
    }>
  >([]);
  const [modalLinkedDefects, setModalLinkedDefects] = useState<
    DefectLinkedToCaseRow[]
  >([]);
  const [modalCaseOpLogs, setModalCaseOpLogs] = useState<TestCaseOpLogRow[]>(
    [],
  );
  const [addDefectIterCode, setAddDefectIterCode] = useState("");
  const [addDefectQuery, setAddDefectQuery] = useState("");
  const [addDefectResults, setAddDefectResults] = useState<DefectLinkOption[]>(
    [],
  );
  const [addDefectLoading, setAddDefectLoading] = useState(false);
  const [defectLinkBusy, setDefectLinkBusy] = useState(false);
  const [modalLinkedDefectPickIds, setModalLinkedDefectPickIds] = useState<
    string[]
  >([]);
  const [addDefectPickIds, setAddDefectPickIds] = useState<string[]>([]);
  const [noticeDialog, setNoticeDialog] = useState<{
    title: string;
    detail: string;
  } | null>(null);

  const [folderNameModal, setFolderNameModal] =
    useState<FolderNameModalState>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const folderNameInputRef = useRef<HTMLInputElement | null>(null);

  const showNotice = useCallback((title: string, detail: string) => {
    setNoticeDialog({ title, detail });
  }, []);

  const [pendingDesignImportIds, setPendingDesignImportIds] = useState<
    string[]
  >([]);
  const [designImportBusy, setDesignImportBusy] = useState(false);

  const cancelPendingDesignImport = useCallback(() => {
    try {
      sessionStorage.removeItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
    } catch {
      /* ignore */
    }
    setPendingDesignImportIds([]);
  }, []);

  useEffect(() => {
    if (embedMode || designImportFlag !== "1") return;
    let ids: string[] = [];
    try {
      const raw = sessionStorage.getItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
      if (raw) {
        const j = JSON.parse(raw) as { ids?: unknown; ts?: number };
        const ts = typeof j.ts === "number" ? j.ts : 0;
        if (Date.now() - ts > 86400000) {
          sessionStorage.removeItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
        } else if (Array.isArray(j.ids)) {
          ids = j.ids.filter(
            (x): x is string => typeof x === "string" && x.trim() !== "",
          );
        }
      }
    } catch {
      try {
        sessionStorage.removeItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
      } catch {
        /* ignore */
      }
    }
    if (ids.length > 0) {
      setPendingDesignImportIds(ids);
    } else {
      showNotice(
        "无法导入",
        "未找到待导入的测试设计。请返回测试设计页勾选节点后，再点「批量导入到用例库」。",
      );
    }
    router.replace("/test-cases", { scroll: false });
  }, [embedMode, designImportFlag, router, showNotice]);

  const [caseSearchQuery, setCaseSearchQuery] = useState("");
  const [advFilter, setAdvFilter] = useState({ ...DEFAULT_ADV_FILTER });
  const [advFilterOpen, setAdvFilterOpen] = useState(false);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string>("");
  const [restoreArchiveOpen, setRestoreArchiveOpen] = useState(false);
  const [restoreArchiveRows, setRestoreArchiveRows] = useState<
    Array<{
      id: string;
      originalId: string;
      caseNo: string;
      title: string;
      folderId: string;
      deletedAt: string;
    }>
  >([]);
  const [restoreArchivePick, setRestoreArchivePick] = useState<string[]>([]);
  const [restoreArchiveLoading, setRestoreArchiveLoading] = useState(false);
  const [restoreArchiveWorking, setRestoreArchiveWorking] = useState(false);
  const [restoreFallbackFolderId, setRestoreFallbackFolderId] = useState("");
  const [execRestoreOpen, setExecRestoreOpen] = useState(false);
  const [deletedExecRows, setDeletedExecRows] = useState<
    DeletedTestCaseExecRecordRow[]
  >([]);
  const [execRestorePick, setExecRestorePick] = useState<string[]>([]);
  const [execRestoreLoading, setExecRestoreLoading] = useState(false);
  const [execRestoreWorking, setExecRestoreWorking] = useState(false);
  const [batchWorking, setBatchWorking] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchEditWorking, setBatchEditWorking] = useState(false);
  const [batchStatusSel, setBatchStatusSel] = useState("keep");
  const [batchPrioritySel, setBatchPrioritySel] = useState("keep");
  const [batchMaintainerApply, setBatchMaintainerApply] = useState(false);
  const [batchMaintainerText, setBatchMaintainerText] = useState("");
  const [batchSubmitterApply, setBatchSubmitterApply] = useState(false);
  const [batchSubmitterText, setBatchSubmitterText] = useState("");
  const [batchExportOpen, setBatchExportOpen] = useState(false);
  const [exportFieldSel, setExportFieldSel] = useState<
    Record<TestCaseExportColumnKey, boolean>
  >(() => ({ ...DEFAULT_TEST_CASE_EXPORT_FIELDS }));
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectAllFullVisibleRef = useRef<HTMLInputElement>(null);
  const modalLinkedDefectSelectAllRef = useRef<HTMLInputElement>(null);
  const addDefectSelectAllRef = useRef<HTMLInputElement>(null);
  const [addDefectTblChkW, setAddDefectTblChkW] = useState(40);
  const [addDefectTblNoW, setAddDefectTblNoW] = useState(128);
  const [modalLinkedTblChkW, setModalLinkedTblChkW] = useState(40);
  const [modalLinkedTblNoW, setModalLinkedTblNoW] = useState(128);
  const [modalLinkedTblNameW, setModalLinkedTblNameW] = useState(200);
  const [modalLinkedTblStatusW, setModalLinkedTblStatusW] = useState(112);
  /** 目录树展开：缺省为展开，仅显式 `false` 表示收起 */
  const [folderExpandedById, setFolderExpandedById] = useState<
    Record<string, boolean>
  >({});
  const [showFolderLevelNumber, setShowFolderLevelNumber] = useState(true);
  const [iterationOptionsReady, setIterationOptionsReady] = useState(false);
  const [sidebarPrefReady, setSidebarPrefReady] = useState(false);
  const [sidebarPrefResolved, setSidebarPrefResolved] = useState(false);
  const pendingPrefIterationCodeRef = useRef<string | null>(null);

  const toggleFolderExpand = useCallback((folderId: string) => {
    setFolderExpandedById((prev) => {
      const open = prev[folderId] !== false;
      return { ...prev, [folderId]: !open };
    });
  }, []);

  const {
    visibleOrdered,
    config: columnConfig,
    setVisible,
    moveKey,
    setWidth,
    widthFor,
    resetDefaults,
  } = useTestCaseListColumns();
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const columnPanelRef = useRef<HTMLDivElement | null>(null);
  const resizeDrag = useRef<{
    key: DataColumnKey;
    startX: number;
    startW: number;
  } | null>(null);

  const [folderPaneW, setFolderPaneW] = useState(288);
  const startResizeFolderPane = useCallback(
    (startX: number) => {
      const startW = folderPaneW;
      const onMove = (e: MouseEvent) => {
        const dx = e.clientX - startX;
        setFolderPaneW(
          Math.max(200, Math.min(440, Math.round(startW + dx))),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [folderPaneW],
  );

  const [folderSearchFooterH, setFolderSearchFooterH] = useState(
    FOLDER_SEARCH_FOOTER_DEFAULT_H,
  );
  const folderSearchFooterHRef = useRef(FOLDER_SEARCH_FOOTER_DEFAULT_H);
  useEffect(() => {
    folderSearchFooterHRef.current = folderSearchFooterH;
  }, [folderSearchFooterH]);

  const startResizeFolderSearchFooter = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture?.(e.pointerId);
      const sy = e.clientY;
      const h0 = folderSearchFooterHRef.current;
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - sy;
        const next = Math.min(
          340,
          Math.max(96, Math.round(h0 + dy)),
        );
        setFolderSearchFooterH(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try {
          el.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [],
  );

  const [folderUpperPaneH, setFolderUpperPaneH] = useState(
    FOLDER_UPPER_PANE_DEFAULT_H,
  );
  const folderUpperPaneHRef = useRef(FOLDER_UPPER_PANE_DEFAULT_H);
  useEffect(() => {
    folderUpperPaneHRef.current = folderUpperPaneH;
  }, [folderUpperPaneH]);

  const startResizeFolderUpperPane = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture?.(e.pointerId);
      const sy = e.clientY;
      const h0 = folderUpperPaneHRef.current;
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - sy;
        const maxCap = Math.max(
          FOLDER_UPPER_PANE_MIN_H + 80,
          Math.min(620, Math.floor(window.innerHeight - 200)),
        );
        const next = Math.min(
          maxCap,
          Math.max(FOLDER_UPPER_PANE_MIN_H, Math.round(h0 + dy)),
        );
        setFolderUpperPaneH(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try {
          el.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [],
  );

  const treeLive = useMemo(() => buildTree(folders), [folders]);
  const folderNameMap = useMemo(
    () => new Map(folders.map((f) => [f.id, f.name] as const)),
    [folders],
  );

  useEffect(() => {
    if (selectedFolderId === null && treeLive[0]) {
      setSelectedFolderId(treeLive[0].id);
    }
  }, [treeLive, selectedFolderId]);

  useEffect(() => {
    setSelectedCaseIds([]);
  }, [selectedFolderId]);

  const filteredCases = useMemo(() => {
    let list = cases;
    const q = caseSearchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.caseNo.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q),
      );
    }
    const f = advFilter;
    if (f.status) {
      list = list.filter((c) => c.status === f.status);
    }
    if (f.priorityText.trim()) {
      const raw = f.priorityText.trim();
      const rawLow = raw.toLowerCase();
      const m = rawLow.match(/^l?([0-4])$/);
      const tier = m ? Number(m[1]) : null;
      const n = Number.parseInt(raw, 10);
      list = list.filter((c) => {
        const disp = formatCaseLevelDisplay(c.priority).toLowerCase();
        if (tier !== null) return c.priority === tier;
        if (!Number.isNaN(n)) return c.priority === n;
        return (
          disp.includes(rawLow) || String(c.priority ?? "").includes(raw)
        );
      });
    }
    if (f.maintainer.trim()) {
      const m = f.maintainer.trim().toLowerCase();
      list = list.filter((c) =>
        (c.maintainer ?? "").toLowerCase().includes(m),
      );
    }
    if (f.submitter.trim()) {
      const s = f.submitter.trim().toLowerCase();
      list = list.filter((c) =>
        (c.submitter ?? "").toLowerCase().includes(s),
      );
    }
    if (f.folderPathContains.trim()) {
      const p = f.folderPathContains.trim().toLowerCase();
      list = list.filter((c) => c.folderPath.toLowerCase().includes(p));
    }
    const createFrom = dayBoundaryMs(f.createdFrom, false);
    const createTo = dayBoundaryMs(f.createdTo, true);
    if (createFrom !== null || createTo !== null) {
      list = list.filter((c) =>
        inSelectableDateRange(c.createdAt, createFrom, createTo),
      );
    }
    const upFrom = dayBoundaryMs(f.updatedFrom, false);
    const upTo = dayBoundaryMs(f.updatedTo, true);
    if (upFrom !== null || upTo !== null) {
      list = list.filter((c) =>
        inSelectableDateRange(c.updatedAt, upFrom, upTo),
      );
    }
    return list;
  }, [cases, caseSearchQuery, advFilter]);

  const casePager = usePagination(filteredCases, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.testCases",
  });
  const allFilteredCaseIds = useMemo(
    () => filteredCases.map((c) => c.id),
    [filteredCases],
  );
  const caseListPagedRowIdsRef = useRef<string[]>([]);
  caseListPagedRowIdsRef.current = casePager.pagedItems.map((c) => c.id);
  const selectedCaseIdsRef = useRef(selectedCaseIds);
  selectedCaseIdsRef.current = selectedCaseIds;
  const { onRowCheckboxPointerDown, tableBodyRef: caseListTableBodyRef } =
    useRowCheckboxBrushByIds({
      pagedRowIdsRef: caseListPagedRowIdsRef,
      selectedIdsRef: selectedCaseIdsRef,
      setSelectedIds: setSelectedCaseIds,
    });

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    if (selectedCaseIds.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const pageIds = casePager.pagedItems.map((c) => c.id);
    const selectedSet = new Set(selectedCaseIds);
    const allPageSelected =
      pageIds.length > 0 && pageIds.every((id) => selectedSet.has(id));
    el.indeterminate = !allPageSelected;
    el.checked = allPageSelected;
  }, [casePager.pagedItems, selectedCaseIds]);

  useEffect(() => {
    const el = selectAllFullVisibleRef.current;
    if (!el) return;
    const ids = allFilteredCaseIds;
    if (ids.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const fullSet = new Set(ids);
    const exactAll =
      selectedCaseIds.length === ids.length &&
      selectedCaseIds.every((id) => fullSet.has(id));
    const someInList = ids.some((id) => selectedCaseIds.includes(id));
    el.checked = exactAll;
    el.indeterminate = someInList && !exactAll;
  }, [allFilteredCaseIds, selectedCaseIds]);

  const toggleSelectAllFilteredPage = useCallback(() => {
    const ids = casePager.pagedItems.map((c) => c.id);
    if (ids.length === 0) return;
    setSelectedCaseIds((prev) => {
      const pageSet = new Set(ids);
      const allOn = ids.every((id) => prev.includes(id));
      return allOn
        ? prev.filter((id) => !pageSet.has(id))
        : [...new Set([...prev, ...ids])];
    });
  }, [casePager.pagedItems]);

  const toggleSelectAllFilteredCasesFull = useCallback(() => {
    const ids = allFilteredCaseIds;
    if (ids.length === 0) return;
    setSelectedCaseIds((prev) => {
      const fullSet = new Set(ids);
      const exact =
        prev.length === ids.length &&
        prev.every((id) => fullSet.has(id));
      if (exact) return [];
      return [...ids];
    });
  }, [allFilteredCaseIds]);

  const clearSelection = useCallback(() => setSelectedCaseIds([]), []);

  const closeMenus = useCallback(() => {
    setFolderMenu(null);
    setCaseMenu(null);
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent | PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (menuRef.current?.contains(e.target)) return;
      closeMenus();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenus();
    };
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [closeMenus]);

  useEffect(() => {
    if (!folderNameModal) return;
    if (folderNameModal.mode === "rename") {
      setFolderNameDraft(folderNameModal.initial);
    } else {
      setFolderNameDraft("");
    }
    const t = window.setTimeout(() => folderNameInputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFolderNameModal(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [folderNameModal]);

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    menuDims.current = { w: r.width, h: r.height };
  }, [folderMenu, caseMenu]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = resizeDrag.current;
      if (!d) return;
      setWidth(d.key, d.startW + (e.clientX - d.startX));
    };
    const onUp = () => {
      resizeDrag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setWidth]);

  useEffect(() => {
    if (!columnPanelOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (columnPanelRef.current?.contains(e.target)) return;
      setColumnPanelOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [columnPanelOpen]);

  const reloadFolders = useCallback(async () => {
    if (!effectiveProductId) {
      setFolders([]);
      return;
    }
    try {
      const f = await listFoldersFlat(effectiveProductId);
      setFolders(f);
    } catch {
      showNotice(
        "加载目录失败",
        "无法从服务器获取文件夹列表，请检查网络或稍后刷新页面。",
      );
    }
  }, [effectiveProductId, showNotice]);

  useEffect(() => {
    if (!effectiveProductId) {
      setFolders([]);
      setSelectedFolderId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const f = await listFoldersFlat(effectiveProductId);
        if (cancelled) return;
        setFolders(f);
        setSelectedFolderId((prev) => {
          if (prev && f.some((x) => x.id === prev)) return prev;
          const roots = buildTree(f);
          return roots[0]?.id ?? null;
        });
      } catch {
        if (!cancelled) {
          setFolders([]);
          showNotice(
            "加载目录失败",
            "无法从服务器获取文件夹列表，请检查网络或稍后刷新页面。",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveProductId, showNotice]);

  const reloadCases = useCallback(async () => {
    if (!selectedFolderId || !effectiveProductId) {
      setCases([]);
      return;
    }
    setLoadingCases(true);
    try {
      const list = await listTestCasesInFolder(
        selectedFolderId,
        iterationCode || null,
        effectiveProductId,
      );
      setCases(list);
    } catch {
      setCases([]);
      showNotice(
        "加载用例失败",
        "无法加载当前目录下的用例列表，请稍后重试或刷新页面。",
      );
    } finally {
      setLoadingCases(false);
    }
  }, [selectedFolderId, iterationCode, effectiveProductId, showNotice]);

  const openRestoreArchiveModal = useCallback(async () => {
    setRestoreArchiveLoading(true);
    setRestoreArchivePick([]);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const r = await listDeletedTestCasesArchive({
      deletedAfter: start.toISOString(),
    });
    setRestoreArchiveLoading(false);
    if (r.error) {
      showNotice("加载失败", r.error);
      return;
    }
    setRestoreArchiveRows(r.rows);
    setRestoreFallbackFolderId(selectedFolderId ?? folders[0]?.id ?? "");
    setRestoreArchiveOpen(true);
  }, [folders, selectedFolderId, showNotice]);

  const reloadFolderCounts = useCallback(async () => {
    if (!effectiveProductId) {
      setFolderSubtreeCounts({});
      return;
    }
    try {
      const m = await countTestCasesByFolderSubtree(
        iterationCode ? iterationCode : null,
        effectiveProductId,
      );
      setFolderSubtreeCounts(m);
    } catch {
      setFolderSubtreeCounts({});
    }
  }, [iterationCode, effectiveProductId]);

  const runRestoreFromArchive = useCallback(async () => {
    if (restoreArchivePick.length === 0) {
      showNotice("恢复", "请先勾选要恢复的条目。");
      return;
    }
    setRestoreArchiveWorking(true);
    const res = await restoreTestCasesFromArchive(restoreArchivePick, {
      folderIdIfMissing: restoreFallbackFolderId.trim() || undefined,
    });
    setRestoreArchiveWorking(false);
    if (res.error) {
      showNotice("未能恢复", res.error);
      return;
    }
    const noteBlock =
      res.notes && res.notes.length > 0 ? `\n${res.notes.join("\n")}` : "";
    showNotice(
      "已恢复",
      `成功恢复 ${res.restored ?? 0} 条用例。${noteBlock}`,
    );
    setRestoreArchiveOpen(false);
    setRestoreArchivePick([]);
    await reloadCases();
    await reloadFolderCounts();
  }, [
    reloadCases,
    reloadFolderCounts,
    restoreArchivePick,
    restoreFallbackFolderId,
    showNotice,
  ]);

  const runPendingDesignImport = useCallback(async () => {
    if (!selectedFolderId || pendingDesignImportIds.length === 0) return;
    const n = pendingDesignImportIds.length;
    setDesignImportBusy(true);
    try {
      const r = await bulkImportDesignsToTestCases({
        testDesignIds: pendingDesignImportIds,
        folderId: selectedFolderId,
        productId: effectiveProductId,
      });
      if (r.error) {
        showNotice("导入失败", r.error);
        return;
      }
      try {
        sessionStorage.removeItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
      } catch {
        /* ignore */
      }
      setPendingDesignImportIds([]);
      const imported = r.imported ?? n;
      const skipped = r.skippedDuplicates ?? 0;
      const lines = r.skippedDuplicateDetails ?? [];
      let detail = "";
      if (imported > 0) {
        detail = `本次成功导入 ${imported} 条到当前目录。`;
      } else {
        detail = "本次没有新的用例写入（可能全部为重复名称）。";
      }
      if (skipped > 0) {
        detail += `\n\n因在同一产品与迭代下名称已存在，已跳过 ${skipped} 条：`;
        if (lines.length > 0) {
          detail += `\n${lines.join("\n")}`;
        }
      }
      showNotice(
        imported > 0 || skipped === 0 ? "导入完成" : "导入结束",
        detail,
      );
      void reloadCases();
      void reloadFolderCounts();
    } catch {
      showNotice("导入失败", "请求未能完成，请稍后重试。");
    } finally {
      setDesignImportBusy(false);
    }
  }, [
    pendingDesignImportIds,
    selectedFolderId,
    effectiveProductId,
    reloadCases,
    reloadFolderCounts,
    showNotice,
  ]);

  useEffect(() => {
    if (embedMode) return;
    reloadCases();
  }, [embedMode, reloadCases]);

  useEffect(() => {
    if (embedMode) return;
    void reloadFolderCounts();
  }, [embedMode, reloadFolderCounts]);

  useEffect(() => {
    (async () => {
      try {
        const opts = await listIterationCodeOptions();
        setIterationOptions(opts);
      } catch {
        // ignore
      } finally {
        setIterationOptionsReady(true);
      }
    })();
  }, []);

  const visibleIterationOptions = useMemo(
    () =>
      productId
        ? iterationOptions.filter(
            (o) => o.code === "" || (o.productId ?? "") === productId,
          )
        : iterationOptions,
    [iterationOptions, productId],
  );

  const sharedLibraryProductLabel = useMemo(() => {
    const b = products.find((p) => p.isBaseline);
    if (!b) return null;
    return b.code ? `${b.name}（${b.code}）` : b.name;
  }, [products]);

  useEffect(() => {
    void (async () => {
      try {
        const ps = await listProductOptions();
        setProducts(ps);
      } catch {
        setProducts([]);
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pref = await getGlobalIterationProductPreference();
      if (cancelled) return;
      const candidate = (pref.productId ?? "").trim();
      if (candidate) setProductId(candidate);
      productPrefHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (productId) return;
    if (products.length > 0) setProductId(products[0]!.id);
  }, [productId, products]);

  useEffect(() => {
    if (!productPrefHydratedRef.current || !productId) return;
    const t = window.setTimeout(() => {
      void saveGlobalIterationProductPreference({ productId });
    }, 400);
    return () => clearTimeout(t);
  }, [productId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pref = await getGlobalTestCaseSidebarPreference();
        if (cancelled) return;
        pendingPrefIterationCodeRef.current = (pref.iterationCode ?? "").trim();
        if (pref.folderExpandedById && typeof pref.folderExpandedById === "object") {
          setFolderExpandedById(pref.folderExpandedById);
        }
      } finally {
        if (!cancelled) setSidebarPrefReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!iterationOptionsReady || !sidebarPrefReady || sidebarPrefResolved) return;
    const prefCode = pendingPrefIterationCodeRef.current;
    if (prefCode === null) {
      setSidebarPrefResolved(true);
      return;
    }
    if (!prefCode) {
      setIterationCode("");
      pendingPrefIterationCodeRef.current = null;
      setSidebarPrefResolved(true);
      return;
    }
    if (visibleIterationOptions.some((o) => o.code === prefCode)) {
      setIterationCode((prev) => (prev === prefCode ? prev : prefCode));
    } else {
      setIterationCode("");
    }
    pendingPrefIterationCodeRef.current = null;
    setSidebarPrefResolved(true);
  }, [visibleIterationOptions, iterationOptionsReady, sidebarPrefReady, sidebarPrefResolved]);

  useEffect(() => {
    if (!sidebarPrefResolved) return;
    const t = window.setTimeout(() => {
      void saveGlobalTestCaseSidebarPreference({
        iterationCode,
        folderExpandedById,
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [iterationCode, folderExpandedById, sidebarPrefResolved]);

  useEffect(() => {
    if (!visibleIterationOptions.some((o) => o.code === iterationCode)) {
      setIterationCode("");
    }
  }, [visibleIterationOptions, iterationCode]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pref = await getGlobalTestCaseExecResultHeightPreference();
        if (cancelled) return;
        if (typeof pref.height === "number") {
          setExecResultTextareaHeight(clampExecResultHeight(pref.height));
        }
      } finally {
        if (!cancelled) setExecResultTextareaPrefReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!execResultTextareaPrefReady) return;
    const t = window.setTimeout(() => {
      void saveGlobalTestCaseExecResultHeightPreference({
        height: clampExecResultHeight(execResultTextareaHeight),
      });
    }, 400);
    return () => clearTimeout(t);
  }, [execResultTextareaHeight, execResultTextareaPrefReady]);

  const openCreate = (targetFolderId?: string | null) => {
    const fid = targetFolderId ?? selectedFolderId;
    if (!fid) {
      showNotice("无法新建", "请先在左侧选择目录。");
      return;
    }
    setErr(null);
    closeMenus();
    setEditingId(undefined);
    setCaseNo("");
    setTitle("");
    setTestPlan("");
    // iterationCode 直接使用当前筛选值（由 state 持有）
    setFolderId(fid);
    // 新建默认继承当前迭代筛选
    setPriority("");
    setMaintainer("");
    setStatus("");
    setPrecondition("");
    setOperationSteps("");
    setCaseActualResult("");
    setCaseRemark("");
    setSubmitter("");
    setCaseCreatedAtIso(null);
    setCaseModalTab("basic");
    setModalLinkedDefects([]);
    setModalCaseOpLogs([]);
    setAddDefectIterCode("");
    setAddDefectQuery("");
    setAddDefectResults([]);
    setModalLinkedDefectPickIds([]);
    setAddDefectPickIds([]);
    setExecRecords([]);
    setModalOpen(true);
  };

  const reloadModalDefectsAndLogs = useCallback(async () => {
    if (!editingId) return;
    try {
      const [defRows, logRows] = await Promise.all([
        listDefectsLinkedToTestCase(editingId),
        getTestCaseOpLogs(editingId, 12),
      ]);
      setModalLinkedDefects(defRows);
      setModalLinkedDefectPickIds([]);
      setModalCaseOpLogs(logRows);
    } catch {
      // ignore
    }
  }, [editingId]);

  const embedTaskMetaLocked = embedMode && !!executionTaskId?.trim();
  const metaFieldCls = embedTaskMetaLocked
    ? "cursor-not-allowed bg-zinc-50 text-zinc-600"
    : "";

  const onPasteExecResult = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!embedMode) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const img = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!img) return;
      const f = img.getAsFile();
      if (!f) return;
      e.preventDefault();
      try {
        const normalized = await normalizePastedImagePng(f);
        if (!normalized) {
          showNotice(
            "截图过大",
            "已尝试自动压缩，但截图仍超过 1MB，请手动裁剪后再粘贴。",
          );
          return;
        }
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        setExecRunImages((prev) => [...prev, { id, dataUrl: normalized.dataUrl }]);
        // 仅追加到截图列表，不在文本里插入占位符
      } catch {
        showNotice("处理截图失败", "截图处理失败，请重试或手动裁剪后再粘贴。");
      }
    },
    [embedMode, showNotice],
  );

  useEffect(() => {
    if (caseModalTab === "execRuns" && !editingId) setCaseModalTab("basic");
  }, [caseModalTab, embedMode, executionTaskId, editingId]);

  const reloadExecRecords = useCallback(async () => {
    const taskId = executionTaskId?.trim() || "";
    const caseId = editingId?.trim() || "";
    if (!embedMode || !taskId || !caseId) {
      setExecRecords([]);
      return;
    }
    const r = await listExecutionTaskCaseExecRecords({
      executionTaskId: taskId,
      testCaseId: caseId,
    });
    if (r.error) return;
    setExecRecords(r.records ?? []);
  }, [embedMode, executionTaskId, editingId]);

  const reloadAllExecRecords = useCallback(async () => {
    const caseId = editingId?.trim() || "";
    if (!caseId || embedMode) {
      setAllExecRecords([]);
      return;
    }
    const r = await listTestCaseExecRecords({ testCaseId: caseId });
    if (r.error) return;
    setAllExecRecords(r.records ?? []);
  }, [editingId, embedMode]);

  useEffect(() => {
    if (caseModalTab !== "execRuns") return;
    if (embedMode) void reloadExecRecords();
    else void reloadAllExecRecords();
  }, [caseModalTab, embedMode, reloadAllExecRecords, reloadExecRecords]);

  useEffect(() => {
    if (caseModalTab !== "defects" || !editingId) return;
    const t = window.setTimeout(() => {
      void (async () => {
        setAddDefectLoading(true);
        try {
          const rows = await searchDefectLinkOptions({
            q: addDefectQuery,
            iterationCode: addDefectIterCode || null,
            take: 200,
          });
          setAddDefectResults(rows);
        } finally {
          setAddDefectLoading(false);
        }
      })();
    }, 220);
    return () => clearTimeout(t);
  }, [
    addDefectIterCode,
    addDefectQuery,
    caseModalTab,
    editingId,
  ]);

  const pendingDefectRows = useMemo(
    () =>
      addDefectResults.filter(
        (d) => !modalLinkedDefects.some((l) => l.id === d.id),
      ),
    [addDefectResults, modalLinkedDefects],
  );

  const modalLinkedDefectPickSet = useMemo(
    () => new Set(modalLinkedDefectPickIds),
    [modalLinkedDefectPickIds],
  );
  const addDefectPickSet = useMemo(
    () => new Set(addDefectPickIds),
    [addDefectPickIds],
  );
  const pendingDefectPickKey = useMemo(
    () => pendingDefectRows.map((d) => d.id).join("\0"),
    [pendingDefectRows],
  );

  useEffect(() => {
    setAddDefectPickIds([]);
  }, [pendingDefectPickKey]);

  useEffect(() => {
    const el = modalLinkedDefectSelectAllRef.current;
    if (!el) return;
    if (modalLinkedDefects.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const all = modalLinkedDefects.every((d) =>
      modalLinkedDefectPickSet.has(d.id),
    );
    const some = modalLinkedDefects.some((d) =>
      modalLinkedDefectPickSet.has(d.id),
    );
    el.indeterminate = some && !all;
    el.checked = all;
  }, [modalLinkedDefectPickSet, modalLinkedDefects]);

  useEffect(() => {
    const el = addDefectSelectAllRef.current;
    if (!el) return;
    if (pendingDefectRows.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const all = pendingDefectRows.every((d) => addDefectPickSet.has(d.id));
    const some = pendingDefectRows.some((d) => addDefectPickSet.has(d.id));
    el.indeterminate = some && !all;
    el.checked = all;
  }, [addDefectPickSet, pendingDefectRows]);

  const toggleModalLinkedDefectPick = useCallback((id: string) => {
    setModalLinkedDefectPickIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return Array.from(s);
    });
  }, []);

  const toggleModalLinkedDefectPickAll = useCallback(() => {
    const ids = modalLinkedDefects.map((d) => d.id);
    const allSelected =
      ids.length > 0 && ids.every((id) => modalLinkedDefectPickSet.has(id));
    setModalLinkedDefectPickIds(allSelected ? [] : ids);
  }, [modalLinkedDefectPickSet, modalLinkedDefects]);

  const toggleAddDefectPick = useCallback((id: string) => {
    setAddDefectPickIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return Array.from(s);
    });
  }, []);

  const toggleAddDefectPickAll = useCallback(() => {
    const ids = pendingDefectRows.map((d) => d.id);
    const allSelected =
      ids.length > 0 && ids.every((id) => addDefectPickSet.has(id));
    setAddDefectPickIds(allSelected ? [] : ids);
  }, [addDefectPickSet, pendingDefectRows]);

  const startResizeAddDefectChkVsNo = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = addDefectTblChkW;
      const b0 = addDefectTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setAddDefectTblChkW(Math.min(52, Math.max(32, a0 + dx)));
        setAddDefectTblNoW(Math.min(560, Math.max(72, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [addDefectTblChkW, addDefectTblNoW],
  );

  const startResizeAddDefectNoVsName = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = addDefectTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setAddDefectTblNoW(Math.min(560, Math.max(72, a0 + dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [addDefectTblNoW],
  );

  const startResizeModalLinkedChkVsNo = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = modalLinkedTblChkW;
      const b0 = modalLinkedTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setModalLinkedTblChkW(Math.min(52, Math.max(32, a0 + dx)));
        setModalLinkedTblNoW(Math.min(400, Math.max(72, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [modalLinkedTblChkW, modalLinkedTblNoW],
  );

  const startResizeModalLinkedNoVsName = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = modalLinkedTblNoW;
      const b0 = modalLinkedTblNameW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setModalLinkedTblNoW(Math.min(400, Math.max(72, a0 + dx)));
        setModalLinkedTblNameW(Math.min(640, Math.max(120, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [modalLinkedTblNoW, modalLinkedTblNameW],
  );

  const startResizeModalLinkedNameVsStatus = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = modalLinkedTblNameW;
      const b0 = modalLinkedTblStatusW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setModalLinkedTblNameW(Math.min(640, Math.max(120, a0 + dx)));
        setModalLinkedTblStatusW(Math.min(200, Math.max(80, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [modalLinkedTblNameW, modalLinkedTblStatusW],
  );

  const startResizeModalLinkedStatusVsOp = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = modalLinkedTblStatusW;
      const b0 = modalLinkedTblNameW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setModalLinkedTblStatusW(Math.min(200, Math.max(80, a0 + dx)));
        setModalLinkedTblNameW(Math.min(640, Math.max(120, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [modalLinkedTblStatusW, modalLinkedTblNameW],
  );

  const addSelectedDefectsToCase = useCallback(async () => {
    if (!editingId) return;
    const ids = Array.from(
      new Set(addDefectPickIds.map((x) => x.trim()).filter(Boolean)),
    );
    if (ids.length === 0) return;
    setDefectLinkBusy(true);
    try {
      const r = await linkDefectsToTestCaseBatch(editingId, ids);
      if (r.error) {
        showNotice("关联失败", r.error);
        return;
      }
      setAddDefectPickIds([]);
      setAddDefectQuery("");
      await reloadModalDefectsAndLogs();
    } finally {
      setDefectLinkBusy(false);
    }
  }, [addDefectPickIds, editingId, reloadModalDefectsAndLogs, showNotice]);

  const removeSelectedModalLinkedDefects = useCallback(async () => {
    if (!editingId) return;
    const ids = Array.from(
      new Set(modalLinkedDefectPickIds.map((x) => x.trim()).filter(Boolean)),
    );
    if (ids.length === 0) return;
    if (!window.confirm(`确定移除已选 ${ids.length} 条关联？`)) return;
    setDefectLinkBusy(true);
    try {
      const r = await unlinkDefectsFromTestCaseBatch(editingId, ids);
      if (r.error) {
        showNotice("移除失败", r.error);
        return;
      }
      await reloadModalDefectsAndLogs();
    } finally {
      setDefectLinkBusy(false);
    }
  }, [
    editingId,
    modalLinkedDefectPickIds,
    reloadModalDefectsAndLogs,
    showNotice,
  ]);

  const removeDefectFromCase = async (defectId: string) => {
    if (!editingId) return;
    setDefectLinkBusy(true);
    try {
      const r = await unlinkDefectFromTestCase(editingId, defectId);
      if (r.error) {
        showNotice("移除失败", r.error);
        return;
      }
      await reloadModalDefectsAndLogs();
    } finally {
      setDefectLinkBusy(false);
    }
  };

  const loadDeletedExecRows = useCallback(async () => {
    if (!editingId) {
      setDeletedExecRows([]);
      return;
    }
    setExecRestoreLoading(true);
    const r = await listDeletedTestCaseExecRecords({ testCaseId: editingId });
    setExecRestoreLoading(false);
    if (r.error) {
      showNotice("读取失败", r.error);
      setDeletedExecRows([]);
      return;
    }
    setDeletedExecRows(r.rows ?? []);
  }, [editingId, showNotice]);

  useEffect(() => {
    if (!execRestoreOpen || !editingId) return;
    void loadDeletedExecRows();
  }, [execRestoreOpen, editingId, loadDeletedExecRows]);

  const runRestoreExecRecords = useCallback(async () => {
    if (execRestorePick.length === 0) {
      showNotice("恢复", "请先勾选要恢复的记录。");
      return;
    }
    setExecRestoreWorking(true);
    const r = await restoreTestCaseExecRecordsFromArchive(execRestorePick);
    setExecRestoreWorking(false);
    if (r.error) {
      showNotice("恢复失败", r.error);
      return;
    }
    showNotice(
      "已恢复",
      `成功恢复 ${r.restored ?? execRestorePick.length} 条执行记录。`,
    );
    setExecRestorePick([]);
    setExecRestoreOpen(false);
    if (embedMode) await reloadExecRecords();
    else await reloadAllExecRecords();
  }, [
    embedMode,
    execRestorePick,
    reloadAllExecRecords,
    reloadExecRecords,
    showNotice,
  ]);

  const openEdit = useCallback(async (id: string) => {
    setErr(null);
    closeMenus();
    let full: Awaited<ReturnType<typeof getTestCaseFull>>;
    try {
      full = await getTestCaseFull(id);
    } catch {
      showNotice("打开用例失败", "加载用例详情时出错，请稍后重试。");
      return;
    }
    if (!full) {
      showNotice("无法打开", "用例不存在或已被删除。");
      return;
    }
    if (embedMode && embedOpenCaseIdRef.current !== id) return;
    setEditingId(full.id);
    setCaseNo(full.caseNo);
    setTitle(full.title);
    setTestPlan(full.testPlan ?? "");
    setIterationCode(full.iterationCode ?? "");
    setFolderId(full.folderId);
    setPriority(caseLevelToFormValue(full.priority));
    setMaintainer(full.maintainer ?? "");
    setStatus((full.status ?? "") as TestCaseStatus | "");
    execRunStatusAtOpen.current = full.status ?? "BLOCKED";
    setPrecondition(full.precondition ?? "");
    setOperationSteps(full.operationSteps ?? "");
    setCaseActualResult(full.caseActualResult ?? "");
    setCaseRemark(full.caseRemark ?? "");
    setSubmitter(full.submitter ?? "");
    setCaseCreatedAtIso(
      full.createdAt ? new Date(full.createdAt).toISOString() : null,
    );
    setCaseUpdatedAtIso(
      full.updatedAt ? new Date(full.updatedAt).toISOString() : null,
    );
    setExecRunImages([]);
    setExecRunImageOpen(null);
    setExecRecordDetailOpen(null);
    setCaseModalTab("basic");
    setAddDefectIterCode(full.iterationCode ?? "");
    setAddDefectQuery("");
    setAddDefectResults([]);
    setModalLinkedDefectPickIds([]);
    setAddDefectPickIds([]);
    try {
      const [defRows, logRows] = await Promise.all([
        listDefectsLinkedToTestCase(full.id),
        getTestCaseOpLogs(full.id, 12),
      ]);
      setModalLinkedDefects(defRows);
      setModalCaseOpLogs(logRows);
    } catch {
      setModalLinkedDefects([]);
      setModalCaseOpLogs([]);
    }
    if (embedMode && embedOpenCaseIdRef.current !== id) return;
    setModalOpen(true);
  }, [closeMenus, embedMode, showNotice]);

  useEffect(() => {
    if (embedMode) return;
    if (deepCaseId) {
      void openEdit(deepCaseId);
    }
  }, [embedMode, deepCaseId, openEdit]);

  useEffect(() => {
    if (!embedMode) return;
    if (!openCaseId) {
      setModalOpen(false);
      return;
    }
    void openEdit(openCaseId);
  }, [embedMode, openCaseId, openEdit]);

  useEffect(() => {
    if (!embedMode) return;
    const caseId = openCaseId?.trim() || "";
    const taskId = executionTaskId?.trim() || "";
    if (!caseId || !taskId) {
      setExecResult("");
      setExecResultUpdatedIso(null);
      return;
    }
    void (async () => {
      const r = await getExecutionTaskCaseResult({ executionTaskId: taskId, testCaseId: caseId });
      if (r.error) return;
      setExecResult(r.result?.executionResult ?? "");
      setExecResultUpdatedIso(r.result?.executedAt ?? null);
      setExecRunImages([]);
      setExecRunImageOpen(null);
      setExecRecordDetailOpen(null);
    })();
  }, [embedMode, executionTaskId, openCaseId]);

  const submitCase = async () => {
    setSaving(true);
    setErr(null);
    const pri =
      priority.trim() === ""
        ? null
        : parseCaseLevelOrNull(Number.parseInt(priority, 10));
    try {
      const r = await saveTestCase({
        id: editingId,
        caseNo,
        title,
        testPlan: testPlan.trim() || null,
        iterationCode: iterationCode || null,
        folderId,
        priority: pri,
        maintainer: maintainer.trim() || null,
        status: status ? (status as TestCaseStatus) : null,
        precondition: precondition.trim() || null,
        operationSteps: operationSteps.trim() || null,
        caseActualResult: caseActualResult.trim() || null,
        caseRemark: caseRemark.trim() || null,
        submitter: submitter.trim() || null,
      });
      if (r.error) {
        showNotice("保存失败", r.error);
        return;
      }
      if (embedMode && executionTaskId && editingId) {
        const r2 = await saveExecutionTaskCaseResult({
          executionTaskId,
          testCaseId: editingId,
          executionResult: execResult.trim() || null,
        });
        if (r2.error) {
          showNotice("保存执行结果失败", r2.error);
          return;
        }

        // 通过「保存」同步新增一次执行记录（时间/状态/执行人/执行结果/截图）
        const recordStatus = (status ? (status as TestCaseStatus) : "BLOCKED") as TestCaseStatus;
        const r3 = await addExecutionTaskCaseExecRecord({
          executionTaskId,
          testCaseId: editingId,
          status: recordStatus,
          executor: submitter.trim() || null,
          result: execResult.trim() || null,
          // 通过字符串传输，规避 server action 对深层数组序列化限制
          images: JSON.stringify(execRunImages.map((x) => x.dataUrl)),
          note: null,
        });
        if (r3.error) {
          showNotice("保存执行记录失败", r3.error);
          return;
        }
      }
      setModalOpen(false);
      if (embedMode) {
        onEmbedSaved?.();
        onEmbedClose?.();
      } else {
        void reloadCases();
        void reloadFolderCounts();
      }
    } catch {
      showNotice(
        "保存失败",
        "请求未能完成（网络异常或服务错误），请稍后重试。",
      );
    } finally {
      setSaving(false);
    }
  };

  const removeCase = async (id: string, label: string) => {
    if (!window.confirm(`确定删除用例「${label}」？`)) return;
    setErr(null);
    closeMenus();
    try {
      const r = await deleteTestCase(id);
      if (r.error) {
        showNotice("删除失败", r.error);
        return;
      }
      void reloadCases();
      void reloadFolderCounts();
    } catch {
      showNotice("删除失败", "请求未能完成，请稍后重试。");
    }
  };

  const runBatchEditMeta = useCallback(async () => {
    const ids = selectedCaseIds.filter((id) => cases.some((c) => c.id === id));
    if (ids.length === 0) return;
    const updates: {
      status?: TestCaseStatus | null;
      priority?: number | null;
      maintainer?: string | null;
      submitter?: string | null;
    } = {};
    if (batchStatusSel === "clear") updates.status = null;
    else if (batchStatusSel !== "keep")
      updates.status = batchStatusSel as TestCaseStatus;
    if (batchPrioritySel === "unset") updates.priority = null;
    else if (batchPrioritySel !== "keep")
      updates.priority = Number(batchPrioritySel);
    if (batchMaintainerApply)
      updates.maintainer = batchMaintainerText.trim() || null;
    if (batchSubmitterApply)
      updates.submitter = batchSubmitterText.trim() || null;
    if (Object.keys(updates).length === 0) {
      showNotice("批量修改", "请至少选择一项要修改的内容");
      return;
    }
    setBatchEditWorking(true);
    try {
      const r = await bulkUpdateTestCasesMeta({ ids, updates });
      if (r.error) {
        showNotice("批量修改失败", r.error);
        return;
      }
      setBatchEditOpen(false);
      clearSelection();
      void reloadCases();
      void reloadFolderCounts();
    } catch {
      showNotice("批量修改失败", "请求未能完成，请稍后重试。");
    } finally {
      setBatchEditWorking(false);
    }
  }, [
    selectedCaseIds,
    cases,
    batchStatusSel,
    batchPrioritySel,
    batchMaintainerApply,
    batchMaintainerText,
    batchSubmitterApply,
    batchSubmitterText,
    showNotice,
    clearSelection,
    reloadCases,
    reloadFolderCounts,
  ]);

  const runBatchDelete = async () => {
    if (selectedCaseIds.length === 0) return;
    if (
      !window.confirm(
        `确定删除已勾选的 ${selectedCaseIds.length} 条用例？此操作不可恢复。`,
      )
    ) {
      return;
    }
    setBatchWorking(true);
    try {
      const r = await bulkDeleteTestCases(selectedCaseIds);
      if (r.error) {
        showNotice("批量删除失败", r.error);
        return;
      }
      clearSelection();
      void reloadCases();
      void reloadFolderCounts();
    } catch {
      showNotice("批量删除失败", "请求未能完成，请稍后重试。");
    } finally {
      setBatchWorking(false);
    }
  };

  const runBatchMove = async () => {
    if (selectedCaseIds.length === 0 || !moveTargetFolderId) {
      showNotice("批量移动", "请选择目标文件夹。");
      return;
    }
    setBatchWorking(true);
    try {
      const r = await bulkMoveTestCases(
        selectedCaseIds,
        moveTargetFolderId,
        effectiveProductId,
      );
      if (r.error) {
        showNotice("批量移动失败", r.error);
        return;
      }
      setMoveModalOpen(false);
      clearSelection();
      void reloadCases();
      void reloadFolderCounts();
    } catch {
      showNotice("批量移动失败", "请求未能完成，请稍后重试。");
    } finally {
      setBatchWorking(false);
    }
  };

  const runBatchExport = async () => {
    if (selectedCaseIds.length === 0) return;
    const fields = TEST_CASE_EXPORT_COLUMN_KEYS.filter((k) => exportFieldSel[k]);
    if (fields.length === 0) {
      showNotice("导出失败", "请至少勾选一个导出字段。");
      return;
    }
    setBatchWorking(true);
    try {
      const r = await getTestCasesExportRows(
        selectedCaseIds,
        effectiveProductId,
      );
      if (r.error || !r.rows?.length) {
        showNotice("导出失败", r.error ?? "没有可导出的数据");
        return;
      }
      saveStoredTestCaseExportFields(exportFieldSel);
      const blob = new Blob([buildTestCaseExportCsv(r.rows, fields)], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `用例导出-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBatchExportOpen(false);
    } catch {
      showNotice("导出失败", "生成文件时出错，请稍后重试。");
    } finally {
      setBatchWorking(false);
    }
  };

  const runCreateSubfolder = (parentId: string) => {
    closeMenus();
    setFolderNameModal({ mode: "newChild", parentId });
  };

  const runRenameFolder = (folderId: string) => {
    closeMenus();
    const current = folderNameMap.get(folderId) ?? "";
    setFolderNameModal({ mode: "rename", folderId, initial: current });
  };

  const submitFolderNameModal = async () => {
    const name = folderNameDraft.trim();
    if (!name) {
      showNotice("名称无效", "请输入文件夹名称。");
      return;
    }
    const m = folderNameModal;
    if (!m) return;
    setFolderNameModal(null);
    setErr(null);
    try {
      if (m.mode === "newChild") {
        const r = await createFolder({
          name,
          parentId: m.parentId,
          productId: effectiveProductId,
        });
        if (r.error) {
          showNotice("新建文件夹失败", r.error);
          return;
        }
        setSelectedFolderId(m.parentId);
        await reloadFolders();
        void reloadFolderCounts();
      } else if (m.mode === "rename") {
        const r = await renameFolder(m.folderId, name, effectiveProductId);
        if (r.error) {
          showNotice("重命名失败", r.error);
          return;
        }
        await reloadFolders();
        void reloadFolderCounts();
      } else {
        const r = await createFolder({
          name,
          parentId: null,
          productId: effectiveProductId,
        });
        if (r.error) {
          showNotice("新建根文件夹失败", r.error);
          return;
        }
        await reloadFolders();
        void reloadFolderCounts();
      }
    } catch {
      const title =
        m.mode === "newChild"
          ? "新建文件夹失败"
          : m.mode === "rename"
            ? "重命名失败"
            : "新建根文件夹失败";
      showNotice(title, "请求未能完成，请稍后重试。");
    }
  };

  const runDeleteFolder = async (folderId: string) => {
    closeMenus();
    if (
      !window.confirm(
        "仅当目录下无任何子文件夹且无用例时可删除。确定删除该空目录吗？",
      )
    ) {
      return;
    }
    setErr(null);
    try {
      const r = await deleteFolder(folderId, effectiveProductId);
      if (r.error) {
        showNotice("删除文件夹失败", r.error);
        return;
      }
      if (selectedFolderId === folderId) setSelectedFolderId(null);
      await reloadFolders();
      void reloadFolderCounts();
    } catch {
      showNotice("删除文件夹失败", "请求未能完成，请稍后重试。");
    }
  };

  const runCreateRootFolder = () => {
    setFolderNameModal({ mode: "newRoot" });
  };

  const showFolderMenu = (
    folderId: string,
    clientX: number,
    clientY: number,
  ) => {
    const { w, h } = menuDims.current;
    const p = clampMenuPosition(clientX, clientY, w, h);
    setCaseMenu(null);
    setFolderMenu({ folderId, x: p.x, y: p.y });
  };

  const showFolderMenuBelowButton = (
    folderId: string,
    el: HTMLElement | null,
  ) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    showFolderMenu(folderId, rect.right - 170, rect.bottom + 4);
  };

  const showCaseMenu = (
    caseId: string,
    title: string,
    clientX: number,
    clientY: number,
  ) => {
    const { w, h } = menuDims.current;
    const p = clampMenuPosition(clientX, clientY, w, h);
    setFolderMenu(null);
    setCaseMenu({ caseId, title, x: p.x, y: p.y });
  };

  const runMoveFolderToParent = useCallback(
    async (dragId: string, newParentId: string | null) => {
      if (!effectiveProductId.trim()) return;
      const r = await moveTestCaseFolder({
        folderId: dragId,
        newParentId,
        productId: effectiveProductId,
      });
      if (r.error) {
        showNotice("移动失败", r.error);
        return;
      }
      if (newParentId) {
        setFolderExpandedById((prev) => ({
          ...prev,
          [newParentId]: true,
        }));
      }
      await reloadFolders();
      void reloadFolderCounts();
    },
    [effectiveProductId, reloadFolders, reloadFolderCounts, showNotice],
  );

  const FolderTreeRows = ({
    nodes,
    depth,
    variant = "nested",
    parentFolderId = null,
  }: {
    nodes: FolderNode[];
    depth: number;
    variant?: "root" | "nested";
    parentFolderId?: string | null;
  }) => {
    const siblingIds = nodes.map((x) => x.id);
    const showDragHandle = Boolean(effectiveProductId.trim());

    const runSiblingReorder = async (activeId: string, overId: string) => {
      const next = reorderSiblingFolderIds(siblingIds, activeId, overId);
      if (next.every((id, i) => id === siblingIds[i])) return;
      const r = await reorderTestCaseFolderSiblings({
        productId: effectiveProductId,
        parentId: parentFolderId,
        orderedIds: next,
      });
      if (r.error) {
        showNotice("排序失败", r.error);
        return;
      }
      await reloadFolders();
      void reloadFolderCounts();
    };

    return (
      <ul
        className="space-y-0"
        role={variant === "root" ? "tree" : "group"}
      >
        {nodes.map((n) => {
          const accent = DEPTH_ACCENTS[depth % DEPTH_ACCENTS.length];
          const hasChildren = n.children.length > 0;
          const expanded = folderExpandedById[n.id] !== false;
          const dragKind =
            folderDragId &&
            folderDragOverId === n.id &&
            folderDragId !== n.id &&
            folderDropMode
              ? folderDropMode === "invalid"
                ? ("invalid" as const)
                : folderDropMode === "reorder"
                  ? ("reorder" as const)
                  : ("nest" as const)
              : null;
          const dragRing =
            dragKind === "reorder"
              ? "ring-2 ring-blue-400/80 ring-inset"
              : dragKind === "nest"
                ? "ring-2 ring-emerald-500/70 ring-inset"
                : dragKind === "invalid"
                  ? "ring-2 ring-red-400/70 ring-inset"
                  : "";
          return (
            <li
              key={n.id}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasChildren ? expanded : undefined}
              aria-selected={selectedFolderId === n.id}
            >
              <div
                className={[
                  "group flex items-stretch gap-0 rounded-md transition-colors",
                  selectedFolderId === n.id ? "bg-zinc-200/90" : "hover:bg-zinc-100/80",
                  folderDragId === n.id ? "opacity-60" : "",
                  dragRing,
                ].join(" ")}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showFolderMenu(n.id, e.clientX, e.clientY);
                }}
                onDragOver={(e) => {
                  if (!folderDragId || folderDragId === n.id) return;
                  const dragId = folderDragId;
                  const isSibling =
                    siblingIds.includes(dragId) &&
                    siblingIds.includes(n.id);
                  const subtree = collectDescendantFolderIds(folders, dragId);
                  if (subtree.includes(n.id)) {
                    e.dataTransfer.dropEffect = "none";
                    setFolderDragOverId(n.id);
                    setFolderDropMode("invalid");
                    return;
                  }
                  if (isSibling) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setFolderDragOverId(n.id);
                    setFolderDropMode(
                      e.ctrlKey || e.metaKey ? "reorder" : "nest",
                    );
                    return;
                  }
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setFolderDragOverId(n.id);
                  setFolderDropMode("nest");
                }}
                onDragLeave={(e) => {
                  if (
                    e.currentTarget.contains(e.relatedTarget as Node | null)
                  ) {
                    return;
                  }
                  setFolderDragOverId(null);
                  setFolderDropMode(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const dragId =
                    e.dataTransfer.getData("text/plain").trim() ||
                    folderDragId ||
                    "";
                  setFolderDragId(null);
                  setFolderDragOverId(null);
                  setFolderDropMode(null);
                  if (!dragId || !effectiveProductId.trim() || dragId === n.id)
                    return;

                  const isSibling =
                    siblingIds.includes(dragId) &&
                    siblingIds.includes(n.id);

                  const subtree = collectDescendantFolderIds(folders, dragId);
                  if (subtree.includes(n.id)) {
                    showNotice(
                      "无法移动",
                      "不能将目录移动到其子目录下。",
                    );
                    return;
                  }

                  if (isSibling) {
                    if (e.ctrlKey || e.metaKey) {
                      void runSiblingReorder(dragId, n.id);
                      return;
                    }
                    const moved = folders.find((f) => f.id === dragId);
                    if (moved && (moved.parentId ?? null) === n.id) {
                      return;
                    }
                    void runMoveFolderToParent(dragId, n.id);
                    return;
                  }

                  const moved = folders.find((f) => f.id === dragId);
                  if (moved && (moved.parentId ?? null) === n.id) {
                    return;
                  }

                  void runMoveFolderToParent(dragId, n.id);
                }}
              >
                <div
                  className={[
                    "w-1 shrink-0 rounded-l-md border-l-[3px] bg-transparent",
                    accent,
                  ].join(" ")}
                  aria-hidden
                />
                {showDragHandle ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className="h-7 w-5 shrink-0 cursor-grab select-none self-center rounded-sm active:cursor-grabbing hover:bg-zinc-200/50"
                    draggable
                    title="拖动：松开放入该目录下；同级时按住 Ctrl（Mac ⌘）松手则仅排序"
                    aria-label={`拖动目录：${n.name}`}
                    onClick={(e) => e.preventDefault()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") e.preventDefault();
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", n.id);
                      e.dataTransfer.effectAllowed = "move";
                      setFolderDragId(n.id);
                      setFolderDragOverId(null);
                    }}
                    onDragEnd={() => {
                      setFolderDragId(null);
                      setFolderDragOverId(null);
                      setFolderDropMode(null);
                    }}
                  />
                ) : (
                  <span className="w-5 shrink-0" aria-hidden />
                )}
                <button
                  type="button"
                  draggable={false}
                  className={[
                    "h-7 w-6 shrink-0 self-center rounded text-xs leading-none text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700",
                    hasChildren ? "visible" : "invisible pointer-events-none",
                  ].join(" ")}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    toggleFolderExpand(n.id);
                  }}
                  aria-label={expanded ? "收起子目录" : "展开子目录"}
                  title={expanded ? "收起" : "展开"}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <button
                  type="button"
                  draggable={false}
                  onClick={() => {
                    setSelectedFolderId(n.id);
                    setErr(null);
                    closeMenus();
                  }}
                  className="min-w-0 flex-1 py-1 pl-0.5 pr-0.5 text-left text-xs leading-tight text-zinc-800"
                  style={{ paddingLeft: Math.max(0, depth * 10) }}
                >
                  {showFolderLevelNumber ? (
                    <span className="font-medium tabular-nums text-zinc-400">
                      {depth + 1}.
                    </span>
                  ) : null}
                  {showFolderLevelNumber ? " " : null}
                  <span className="font-medium">{n.name}</span>
                  <span
                    className="ml-1 shrink-0 tabular-nums text-zinc-400"
                    title="该目录及子目录下的用例数（随当前迭代筛选）"
                  >
                    ({folderSubtreeCounts[n.id] ?? 0})
                  </span>
                </button>
                <button
                  type="button"
                  draggable={false}
                  className="flex shrink-0 items-center px-1.5 text-sm leading-none text-zinc-500 opacity-70 hover:bg-zinc-200/50 hover:text-zinc-900 group-hover:opacity-100"
                  title="更多操作"
                  aria-label={`${n.name} 操作`}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    showFolderMenuBelowButton(n.id, e.currentTarget);
                  }}
                >
                  <span className="leading-none">⋮</span>
                </button>
              </div>
              {hasChildren && expanded && (
                <div className="relative ml-1.5 border-l border-dashed border-zinc-200 pl-0.5 pt-0">
                  <FolderTreeRows
                    nodes={n.children}
                    depth={depth + 1}
                    parentFolderId={n.id}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  const selectedFolderName = selectedFolderId
    ? folderPathFromFlat(selectedFolderId, folders)
    : "";

  return (
    <>
      {!embedMode ? (
      <ModuleWorkspaceCard>
        <div className="flex max-h-[calc(100dvh-11rem)] min-h-[70vh] flex-col overflow-hidden lg:flex-row">
        <section
          className="relative flex min-h-[280px] flex-col border-b border-zinc-200 bg-zinc-50/60 lg:min-h-0 lg:border-b-0 lg:border-r lg:border-zinc-200"
          style={{ width: folderPaneW, maxWidth: "100%" }}
        >
          <div
            className="relative flex shrink-0 flex-col overflow-hidden border-b border-zinc-200/80"
            style={{ height: folderUpperPaneH }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="p-3">
            <h2 className="text-sm font-semibold text-zinc-900">目录</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              左侧 <strong>▸/▾</strong> 可展开或收起子目录；拖<strong>三横握把</strong>到某一目录行上<strong>松开</strong>
              → 放入该目录<strong>之下</strong>（含顶层文件夹之间互相挂靠）；按住{" "}
              <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px]">
                Ctrl
              </kbd>{" "}
              （Mac：
              <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px]">
                ⌘
              </kbd>
              ）再松开 → 仅<strong>同级排序</strong>。拖到顶部<strong>虚线区</strong>→ 移到顶层。
              右键或<strong>⋮</strong>新建、重命名、删除。
            </p>
            <div className="mt-2">
              <label className="text-xs font-medium text-zinc-600">
                切换产品
              </label>
              <select
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code ? `${p.name}（${p.code}）` : p.name}
                    {p.isBaseline ? " · 共享用例库" : ""}
                  </option>
                ))}
              </select>
              {sharedLibraryProductLabel ? (
                <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50/90 px-2 py-1.5 text-[11px] leading-snug text-amber-950">
                  已启用共享用例库：目录与用例归属「
                  {sharedLibraryProductLabel}
                  」。切换上方产品仅影响迭代等筛选，不改变左侧目录树。
                </p>
              ) : null}
            </div>
            <div className="mt-2">
              <label className="text-xs font-medium text-zinc-600">
                迭代筛选
              </label>
              <select
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                value={iterationCode}
                onChange={(e) => setIterationCode(e.target.value)}
                title="baseline 表示查看全部迭代"
              >
                {visibleIterationOptions.map((o) => (
                  <option key={o.code || "__baseline__"} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={runCreateRootFolder}
                className="text-xs font-medium text-blue-700 hover:underline"
              >
                + 新建根文件夹
              </button>
              <button
                type="button"
                onClick={() => setShowFolderLevelNumber((prev) => !prev)}
                className="inline-flex h-6 w-6 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-500 hover:border-zinc-400 hover:text-zinc-800"
                aria-label={showFolderLevelNumber ? "隐藏层级序号" : "显示层级序号"}
                title={showFolderLevelNumber ? "隐藏层级序号" : "显示层级序号"}
              >
                {showFolderLevelNumber ? (
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path
                      d="M1.5 10c1.7-3.3 4.6-5 8.5-5s6.8 1.7 8.5 5c-1.7 3.3-4.6 5-8.5 5s-6.8-1.7-8.5-5Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path
                      d="M1.5 10c1.7-3.3 4.6-5 8.5-5 2.2 0 4.1.5 5.7 1.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M18.5 10c-1.7 3.3-4.6 5-8.5 5-2.2 0-4.1-.5-5.7-1.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path d="M3 3l14 14" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                )}
              </button>
            </div>
              </div>
          {!embedMode && pendingDesignImportIds.length > 0 ? (
            <div className="border-t border-blue-200/80 bg-blue-50/95 px-3 py-2.5">
              <div className="text-xs font-semibold text-zinc-900">
                从测试设计导入
              </div>
              <p className="mt-1 text-[11px] leading-snug text-zinc-600">
                待导入{" "}
                <span className="tabular-nums font-medium text-zinc-800">
                  {pendingDesignImportIds.length}
                </span>{" "}
                条设计。请在下方<strong>目录树</strong>中点击选择目标文件夹（与日常浏览用例库相同），再以当前选中目录为准点击「导入到当前目录」。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={
                    designImportBusy ||
                    !selectedFolderId ||
                    treeLive.length === 0
                  }
                  onClick={() => void runPendingDesignImport()}
                  className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {designImportBusy
                    ? "导入中…"
                    : selectedFolderId
                      ? `导入到：${selectedFolderName}`
                      : "导入到当前目录"}
                </button>
                <button
                  type="button"
                  disabled={designImportBusy}
                  onClick={cancelPendingDesignImport}
                  className="text-xs text-zinc-600 underline hover:text-zinc-900 disabled:opacity-50"
                >
                  取消导入
                </button>
              </div>
            </div>
          ) : null}
            </div>
            <div
              data-testid="case-lib-folder-upper-resize"
              className="z-30 flex h-3 w-full shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-zinc-200/90 bg-zinc-100/95 hover:bg-zinc-200/70"
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖动调整目录说明区与目录树高度"
              title="上下拖动：缩小说明区则目录树变高；说明过长时在上方区域内滚动。双击恢复默认高度"
              onPointerDown={startResizeFolderUpperPane}
              onDoubleClick={() =>
                setFolderUpperPaneH(FOLDER_UPPER_PANE_DEFAULT_H)
              }
            >
              <span
                className="pointer-events-none h-1 w-9 rounded-full bg-zinc-400/90"
                aria-hidden
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {err && (
              <p className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
                {err}
              </p>
            )}
            {folderDragId && effectiveProductId.trim() && treeLive.length > 0 ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setFolderDragOverId(FOLDER_TREE_ROOT_DROP);
                  setFolderDropMode("nest");
                }}
                onDragLeave={(e) => {
                  if (
                    e.currentTarget.contains(e.relatedTarget as Node | null)
                  ) {
                    return;
                  }
                  if (folderDragOverId === FOLDER_TREE_ROOT_DROP) {
                    setFolderDragOverId(null);
                    setFolderDropMode(null);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const dragId =
                    e.dataTransfer.getData("text/plain").trim() ||
                    folderDragId ||
                    "";
                  setFolderDragId(null);
                  setFolderDragOverId(null);
                  setFolderDropMode(null);
                  if (!dragId || !effectiveProductId.trim()) return;
                  const cur = folders.find((f) => f.id === dragId);
                  if (cur && (cur.parentId ?? null) === null) return;
                  void runMoveFolderToParent(dragId, null);
                }}
                className={[
                  "mb-2 rounded-lg border border-dashed px-2 py-2 text-center text-[11px] leading-snug transition-colors",
                  folderDragOverId === FOLDER_TREE_ROOT_DROP
                    ? "border-emerald-500 bg-emerald-50 text-emerald-950"
                    : "border-zinc-300 bg-zinc-50/90 text-zinc-600",
                ].join(" ")}
              >
                ↓ 拖放到此处：移到<strong className="font-semibold">顶层</strong>
                （与「根目录」同级）
              </div>
            ) : null}
            {treeLive.length === 0 ? (
              <p className="text-xs text-zinc-500">暂无目录</p>
            ) : (
              <FolderTreeRows
                nodes={treeLive}
                depth={0}
                variant="root"
                parentFolderId={null}
              />
            )}
          </div>
          <div
            className="relative z-30 flex h-3 shrink-0 cursor-row-resize touch-none border-t border-zinc-200/80 bg-zinc-100/80 hover:bg-zinc-200/60"
            data-testid="case-lib-folder-tree-footer-resize"
            role="separator"
            aria-label="拖动调整目录树与搜索区高度"
            title="上下拖动调节目录树与「搜索用例」区域高度；双击恢复默认"
            onPointerDown={startResizeFolderSearchFooter}
            onDoubleClick={() =>
              setFolderSearchFooterH(FOLDER_SEARCH_FOOTER_DEFAULT_H)
            }
          />
          <div
            className="flex min-h-0 shrink-0 flex-col overflow-y-auto bg-zinc-50/90 p-3"
            style={{ height: folderSearchFooterH }}
          >
            <label
              htmlFor="case-lib-search"
              className="text-xs font-medium text-zinc-700"
            >
              搜索用例
            </label>
            <input
              id="case-lib-search"
              type="search"
              autoComplete="off"
              placeholder="用例编号或名称（模糊）"
              className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-900 placeholder:text-zinc-400"
              value={caseSearchQuery}
              onChange={(e) => setCaseSearchQuery(e.target.value)}
            />
            <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
              在当前已加载的列表（本目录及子目录用例）内筛选。
            </p>
          </div>
          <span
            className="absolute right-0 top-0 z-[8] hidden h-full w-2 cursor-col-resize hover:bg-zinc-300/40 lg:block"
            role="separator"
            title="拖动调整左侧宽度"
            onMouseDown={(e) => {
              e.preventDefault();
              startResizeFolderPane(e.clientX);
            }}
          />
        </section>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
          <div className="shrink-0 border-b border-zinc-100 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">
                  当前：{selectedFolderName || "未选择"}
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  列表包含当前目录及<strong>所有子目录</strong>下的用例；
                  <strong>点击用例行</strong>进入编辑；<strong>右键</strong>或{" "}
                  <strong>⋮</strong> 可快捷操作。
                </p>
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAdvFilterOpen((o) => !o)}
                  className={MODULE_TOOLBAR_BTN_SECONDARY}
                  aria-expanded={advFilterOpen}
                >
                  <span>高级筛选</span>{" "}
                  <span className="ml-1 text-xs text-zinc-500">
                    {advFilterOpen ? "▼" : "▶"}
                  </span>
                </button>
                <div className="relative" ref={columnPanelRef}>
                  <button
                    type="button"
                    onClick={() => setColumnPanelOpen((p) => !p)}
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    title="列表列设置（显隐、顺序；表头可拖竖线调宽）"
                    aria-expanded={columnPanelOpen}
                    aria-haspopup="true"
                    aria-label="用例列表列设置"
                  >
                    ⚙
                  </button>
                  {columnPanelOpen ? (
                    <div
                      className="absolute right-0 top-full z-[150] mt-1.5 w-80 max-h-[min(70vh,28rem)] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 text-left shadow-xl"
                      role="dialog"
                      aria-label="列设置"
                    >
                      <p className="text-xs leading-relaxed text-zinc-500">
                        勾选表示在表格中显示。使用上下箭头调整列的先后顺序。在表头列右侧的竖线上按住拖动可调整列宽。
                      </p>
                      <ul className="mt-3 space-y-1">
                        {columnConfig.order.map((key, idx) => (
                          <li
                            key={key}
                            className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-zinc-50"
                          >
                            <input
                              id={`col-vis-${key}`}
                              type="checkbox"
                              className="h-4 w-4 shrink-0 rounded border-zinc-300"
                              checked={columnConfig.visible[key] !== false}
                              onChange={(e) =>
                                setVisible(key, e.target.checked)
                              }
                            />
                            <label
                              htmlFor={`col-vis-${key}`}
                              className="min-w-0 flex-1 cursor-pointer text-sm text-zinc-800"
                            >
                              {COLUMN_LABELS[key]}
                            </label>
                            <div className="flex shrink-0 gap-0.5">
                              <button
                                type="button"
                                className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                disabled={idx === 0}
                                title="上移"
                                aria-label={`将「${COLUMN_LABELS[key]}」列上移`}
                                onClick={() => moveKey(key, -1)}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                disabled={idx === columnConfig.order.length - 1}
                                title="下移"
                                aria-label={`将「${COLUMN_LABELS[key]}」列下移`}
                                onClick={() => moveKey(key, 1)}
                              >
                                ↓
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="mt-3 w-full rounded-lg border border-zinc-200 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                        onClick={() => resetDefaults()}
                      >
                        恢复默认列
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void openRestoreArchiveModal()}
                  disabled={restoreArchiveLoading}
                  className={MODULE_TOOLBAR_BTN_SECONDARY}
                  title="仅恢复「今日 0 点起」删除并已写入归档表的用例；执行任务本身删除后无法从此找回"
                >
                  {restoreArchiveLoading ? "加载归档…" : "恢复今日删除"}
                </button>
                <button
                  type="button"
                  onClick={() => openCreate()}
                  disabled={!selectedFolderId}
                  className={MODULE_TOOLBAR_BTN_PRIMARY}
                >
                  在当前目录新建用例
                </button>
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            {!selectedFolderId ? (
              <p className="text-sm text-zinc-500">请在左侧选择目录。</p>
            ) : loadingCases ? (
              <p className="text-sm text-zinc-500">加载中…</p>
            ) : cases.length === 0 ? (
              <p className="text-sm text-zinc-500">
                当前范围（含子目录）内暂无用例。
              </p>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
                {selectedCaseIds.length > 0 ? (
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/90 px-3 py-2.5 text-sm text-zinc-800">
                    <span>
                      已选{" "}
                      <strong className="tabular-nums">
                        {selectedCaseIds.length}
                      </strong>{" "}
                      条
                    </span>
                    <span className="hidden text-zinc-400 sm:inline">|</span>
                    <button
                      type="button"
                      disabled={batchWorking || batchEditWorking}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                      title="批量修改选中用例在用例库中的状态、等级与维护信息"
                      onClick={() => {
                        setBatchStatusSel("keep");
                        setBatchPrioritySel("keep");
                        setBatchMaintainerApply(false);
                        setBatchMaintainerText("");
                        setBatchSubmitterApply(false);
                        setBatchSubmitterText("");
                        setBatchEditOpen(true);
                      }}
                    >
                      {selectedCaseIds.length > 0
                        ? `批量修改（${selectedCaseIds.length}）`
                        : "批量修改"}
                    </button>
                    <button
                      type="button"
                      disabled={batchWorking}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                      onClick={() => {
                        const stored = parseStoredTestCaseExportFields();
                        setExportFieldSel(
                          stored ?? { ...DEFAULT_TEST_CASE_EXPORT_FIELDS },
                        );
                        setBatchExportOpen(true);
                      }}
                    >
                      批量导出 CSV
                    </button>
                    <button
                      type="button"
                      disabled={batchWorking}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                      onClick={() => {
                        setMoveTargetFolderId(
                          selectedFolderId ?? folders[0]?.id ?? "",
                        );
                        setMoveModalOpen(true);
                      }}
                    >
                      批量移动
                    </button>
                    <button
                      type="button"
                      disabled={batchWorking}
                      className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      onClick={runBatchDelete}
                    >
                      批量删除
                    </button>
                    <button
                      type="button"
                      className="ml-auto text-xs text-zinc-500 underline hover:text-zinc-800"
                      onClick={clearSelection}
                    >
                      取消选择
                    </button>
                  </div>
                ) : null}

                {advFilterOpen ? (
                  <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50/60">
                    <div className="px-3 pb-3 pt-3">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            状态
                          </label>
                          <select
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            value={advFilter.status}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                status: e.target.value as TestCaseStatus | "",
                              }))
                            }
                          >
                            <option value="">全部</option>
                            {testCaseStatusOptions.map((o) => (
                              <option
                                key={o.value}
                                value={o.value}
                                style={testCaseStatusSelectOptionStyle[o.value]}
                              >
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            用例等级
                          </label>
                          <input
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            placeholder="如 L2、2"
                            value={advFilter.priorityText}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                priorityText: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            维护人
                          </label>
                          <input
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            placeholder="模糊包含"
                            value={advFilter.maintainer}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                maintainer: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            提交人
                          </label>
                          <input
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            placeholder="模糊包含"
                            value={advFilter.submitter}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                submitter: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="text-xs font-medium text-zinc-600">
                            所在目录路径
                          </label>
                          <input
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            placeholder="路径关键字（模糊）"
                            value={advFilter.folderPathContains}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                folderPathContains: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            创建时间起
                          </label>
                          <input
                            type="date"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            value={advFilter.createdFrom}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                createdFrom: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            创建时间止
                          </label>
                          <input
                            type="date"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            value={advFilter.createdTo}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                createdTo: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            更新时间起
                          </label>
                          <input
                            type="date"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            value={advFilter.updatedFrom}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                updatedFrom: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            更新时间止
                          </label>
                          <input
                            type="date"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                            value={advFilter.updatedTo}
                            onChange={(e) =>
                              setAdvFilter((p) => ({
                                ...p,
                                updatedTo: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                          onClick={() => setAdvFilter({ ...DEFAULT_ADV_FILTER })}
                        >
                          重置筛选条件
                        </button>
                        <span className="self-center text-xs text-zinc-500">
                          与顶部「搜索用例」同时生效；列表共{" "}
                          <strong>{cases.length}</strong> 条，符合条件{" "}
                          <strong>{filteredCases.length}</strong> 条
                        </span>
                      </div>
                    </div>
                  </div>
                ) : null}

                {filteredCases.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    没有符合当前搜索与筛选条件的用例。可尝试清空左侧搜索框或重置高级筛选。
                  </p>
                ) : (
                      <table
                        className="w-full table-fixed text-left text-sm"
                        style={{
                          minWidth:
                            40 +
                            visibleOrdered.reduce(
                              (sum, k) => sum + widthFor(k),
                              0,
                            ) +
                            48,
                        }}
                      >
                      <colgroup>
                        <col style={{ width: 56 }} />
                        {visibleOrdered.map((k) => (
                          <col key={k} style={{ width: widthFor(k) }} />
                        ))}
                        <col style={{ width: 48 }} />
                      </colgroup>
                      <thead className="border-b border-zinc-200 bg-zinc-50/80 text-xs text-zinc-500">
                        <tr>
                          <th className="w-16 min-w-[4rem] py-2.5 pl-3 pr-1 align-bottom">
                            <div className="flex items-end gap-1">
                              <input
                                ref={selectAllRef}
                                type="checkbox"
                                className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                onChange={toggleSelectAllFilteredPage}
                                title="全选当前页（可与其它页已选合并）"
                                aria-label="全选当前页"
                              />
                              <input
                                ref={selectAllFullVisibleRef}
                                type="checkbox"
                                className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                onChange={toggleSelectAllFilteredCasesFull}
                                title="全选列表：选中当前筛选下全部用例（与分页「/ 总数」一致）"
                                aria-label="全选全部可见用例"
                              />
                            </div>
                          </th>
                          {visibleOrdered.map((k) => (
                            <th
                              key={k}
                              className="relative select-none py-2.5 pr-2 align-bottom font-medium"
                            >
                              <span className="block truncate pr-2">
                                {COLUMN_LABELS[k]}
                              </span>
                              <span
                                role="separator"
                                aria-hidden
                                className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-zinc-300/40"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  resizeDrag.current = {
                                    key: k,
                                    startX: e.clientX,
                                    startW: widthFor(k),
                                  };
                                }}
                              />
                            </th>
                          ))}
                          <th className="w-12 py-2.5 pr-3 text-right align-bottom font-medium" />
                        </tr>
                      </thead>
                      <tbody
                        ref={caseListTableBodyRef}
                        className="divide-y divide-zinc-100"
                      >
                        {casePager.pagedItems.map((c) => (
                          <tr
                            key={c.id}
                            data-pm-row-select={c.id}
                            className="group cursor-pointer hover:bg-zinc-50/90"
                            title={`打开编辑：${c.caseNo} ${c.title}`}
                            onClick={() => void openEdit(c.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              showCaseMenu(c.id, c.title, e.clientX, e.clientY);
                            }}
                          >
                            <td
                              className="py-2.5 pl-3 pr-1 align-top"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-zinc-300"
                                checked={selectedCaseIds.includes(c.id)}
                                onChange={() => {}}
                                onClick={(e) => e.preventDefault()}
                                onPointerDown={(e) =>
                                  onRowCheckboxPointerDown(e, c.id)
                                }
                                onKeyDown={(e) => {
                                  if (e.key !== " " && e.key !== "Enter") return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedCaseIds((prev) =>
                                    prev.includes(c.id)
                                      ? prev.filter((x) => x !== c.id)
                                      : [...prev, c.id],
                                  );
                                }}
                                title="按住并拖动经过多行可连续勾选"
                                aria-label={`选择 ${c.caseNo}`}
                              />
                            </td>
                            {visibleOrdered.map((k) => (
                              <td
                                key={k}
                                className="max-w-0 overflow-hidden py-2.5 pr-2 align-top"
                              >
                                <div className="min-w-0">
                                  <CaseListDataCell col={k} c={c} />
                                </div>
                              </td>
                            ))}
                            <td
                              className="py-2.5 pr-3 text-right align-top"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="rounded px-1.5 py-0.5 text-zinc-500 opacity-60 hover:bg-zinc-200 hover:text-zinc-900 group-hover:opacity-100"
                                title="操作"
                                aria-label={`${c.title} 操作`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  showCaseMenu(
                                    c.id,
                                    c.title,
                                    e.currentTarget.getBoundingClientRect()
                                      .right - 8,
                                    e.currentTarget.getBoundingClientRect()
                                      .bottom + 4,
                                  );
                                }}
                              >
                                ⋮
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      </table>
                )}
                </div>
                {filteredCases.length > 0 ? (
                  <div className="shrink-0 border-t border-zinc-100 bg-zinc-50/50 px-1 py-2.5">
                    <PaginationBar
                      page={casePager.page}
                      pageCount={casePager.pageCount}
                      pageSize={casePager.pageSize}
                      pageSizeOptions={casePager.pageSizeOptions}
                      rangeLabel={casePager.rangeLabel}
                      onPageChange={casePager.setPage}
                      onPageSizeChange={casePager.setPageSize}
                      className="!mt-0 w-full justify-end pt-0"
                    />
                  </div>
                ) : null}
              </div>
            )}

            <p className="mt-6 shrink-0 text-center text-xs text-zinc-400">
              <Link href="/test-design" className="hover:underline">
                前往测试设计
              </Link>
            </p>
          </div>
        </section>
        </div>
      </ModuleWorkspaceCard>
      ) : null}

      {(folderMenu || caseMenu) && (
        <div
          ref={menuRef}
          className="fixed z-[200] min-w-[10.5rem] rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg"
          style={{
            top: folderMenu?.y ?? caseMenu?.y ?? 0,
            left: folderMenu?.x ?? caseMenu?.x ?? 0,
          }}
          role="menu"
        >
          {folderMenu && (
            <>
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left hover:bg-zinc-100"
                onClick={() => runCreateSubfolder(folderMenu.folderId)}
              >
                新建子文件夹
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left hover:bg-zinc-100"
                onClick={() => {
                  setSelectedFolderId(folderMenu.folderId);
                  openCreate(folderMenu.folderId);
                }}
              >
                在此新建用例
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left hover:bg-zinc-100"
                onClick={() => runRenameFolder(folderMenu.folderId)}
              >
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left text-red-700 hover:bg-red-50"
                onClick={() => runDeleteFolder(folderMenu.folderId)}
              >
                删除
              </button>
            </>
          )}
          {caseMenu && (
            <>
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left hover:bg-zinc-100"
                onClick={() => void openEdit(caseMenu.caseId)}
              >
                编辑
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left text-red-700 hover:bg-red-50"
                onClick={() => removeCase(caseMenu.caseId, caseMenu.title)}
              >
                删除
              </button>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/45 p-4"
          role="dialog"
          aria-modal
        >
          <div
            className="mb-8 flex max-h-[92vh] w-[66.67vw] min-h-[min(70vh,720px)] max-w-[1200px] flex-col rounded-2xl border border-zinc-200 bg-white shadow-xl"
          >
            <div className="shrink-0 border-b border-zinc-100 px-6 py-4">
              {!embedMode ? (
                <h3 className="text-lg font-semibold text-zinc-900">
                  {editingId ? "编辑用例" : "新建用例"}
                </h3>
              ) : null}
              <div className="mt-2">
                <input
                  className="w-full overflow-x-auto whitespace-nowrap rounded-lg border border-transparent bg-transparent px-0 py-0 text-lg font-semibold text-zinc-900 outline-none focus:border-transparent focus:ring-0"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="用例名称"
                />
                <div className="mt-1 text-xs text-zinc-500">
                  用例编号：
                  {editingId
                    ? caseNo.trim() || "—"
                    : caseNo.trim()
                      ? caseNo
                      : "（保存后自动生成）"}
                  {caseCreatedAtIso ? (
                    <span className="ml-3 tabular-nums">
                      创建时间：{formatTs(caseCreatedAtIso)}
                    </span>
                  ) : null}
                {caseUpdatedAtIso ? (
                  <span className="ml-3 tabular-nums">
                    修改时间：{formatTs(caseUpdatedAtIso)}
                  </span>
                ) : null}
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs">
                  <button
                    type="button"
                    className={[
                      "rounded-md px-2.5 py-1 font-medium",
                      caseModalTab === "basic"
                        ? "bg-zinc-900 text-white"
                        : "text-zinc-700 hover:bg-zinc-50",
                    ].join(" ")}
                    onClick={() => setCaseModalTab("basic")}
                  >
                    基本信息
                  </button>
                  <button
                    type="button"
                    className={[
                      "rounded-md px-2.5 py-1 font-medium",
                      caseModalTab === "defects"
                        ? "bg-zinc-900 text-white"
                        : "text-zinc-700 hover:bg-zinc-50",
                    ].join(" ")}
                    onClick={() => setCaseModalTab("defects")}
                  >
                    关联缺陷
                  </button>
                  {editingId ? (
                    <button
                      type="button"
                      className={[
                        "rounded-md px-2.5 py-1 font-medium",
                        caseModalTab === "execRuns"
                          ? "bg-zinc-900 text-white"
                          : "text-zinc-700 hover:bg-zinc-50",
                      ].join(" ")}
                      onClick={() => setCaseModalTab("execRuns")}
                    >
                      执行记录
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={[
                      "rounded-md px-2.5 py-1 font-medium",
                      caseModalTab === "ops"
                        ? "bg-zinc-900 text-white"
                        : "text-zinc-700 hover:bg-zinc-50",
                    ].join(" ")}
                    onClick={() => setCaseModalTab("ops")}
                  >
                    操作记录
                  </button>
                  </div>
                  {editingId && caseModalTab === "execRuns" ? (
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      onClick={() => {
                        setExecRestorePick([]);
                        setExecRestoreOpen(true);
                      }}
                    >
                      恢复执行记录
                    </button>
                  ) : null}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {caseModalTab === "basic"
                    ? "测试计划与正文在左，目录与元数据在右。"
                    : caseModalTab === "defects"
                      ? "来自缺陷管理中「关联用例」的反向列表。"
                      : caseModalTab === "execRuns"
                        ? "按时间倒序；新增会以当前时间落库，并同步写入「操作记录」。"
                        : `最近 ${modalCaseOpLogs.length} 条（最多加载 12 条）`}
                </div>
              </div>

              {caseModalTab === "basic" ? (
                <div className="space-y-5">
                  <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
                    <div className="min-w-0 space-y-3">
                      {!editingId ? (
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            用例编号（可选）
                          </label>
                          <input
                            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                            value={caseNo}
                            onChange={(e) => setCaseNo(e.target.value)}
                            placeholder="留空则保存后自动使用内部 ID 作为编号"
                          />
                        </div>
                      ) : null}
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          测试计划
                        </label>
                        <textarea
                          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                          rows={2}
                          value={testPlan}
                          onChange={(e) => setTestPlan(e.target.value)}
                        />
                      </div>

                      <section
                        className={
                          embedMode && executionTaskId
                            ? "rounded-xl border border-transparent bg-transparent p-0"
                            : "rounded-xl border border-zinc-200 bg-zinc-50/40 p-4"
                        }
                      >
                        {!embedMode ? (
                          <>
                            <h4 className="text-sm font-semibold text-zinc-800">
                              用例正文（前置条件 / 操作步骤 / 预期结果 / 备注）
                            </h4>
                            <p className="mt-1 text-xs text-zinc-500">
                              创建时间在首次保存时由系统记录；之后修改用例不会改变创建时间。
                            </p>
                          </>
                        ) : null}
                        {embedMode && executionTaskId ? (
                          <div className="mt-3 max-h-[min(52vh,640px)] overflow-y-auto rounded-lg border border-zinc-200 bg-white">
                            {(
                              [
                                ["前置条件", precondition] as const,
                                ["操作步骤", operationSteps] as const,
                                ["预期结果", caseActualResult] as const,
                                ["备注", caseRemark] as const,
                              ] as const
                            ).map(([label, val], i) => (
                              <div
                                key={label}
                                className={[
                                  "px-3 py-3",
                                  i > 0 ? "border-t border-zinc-100" : "",
                                ].join(" ")}
                              >
                                <div className="text-xs font-medium text-zinc-700">
                                  {label}
                                </div>
                                <div className="mt-1.5 min-h-[3.25rem] whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800">
                                  {val?.trim() ? val : "—"}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:gap-5">
                            <div className="flex min-h-0 flex-col">
                              <label className="shrink-0 text-xs font-medium text-zinc-700">
                                前置条件
                              </label>
                              <textarea
                                className="mt-1.5 min-h-[240px] flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed"
                                value={precondition}
                                onChange={(e) => setPrecondition(e.target.value)}
                              />
                            </div>
                            <div className="flex min-h-0 flex-col">
                              <label className="shrink-0 text-xs font-medium text-zinc-700">
                                操作步骤
                              </label>
                              <textarea
                                className="mt-1.5 min-h-[240px] flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed"
                                value={operationSteps}
                                onChange={(e) =>
                                  setOperationSteps(e.target.value)
                                }
                              />
                            </div>
                            <div className="flex min-h-0 flex-col">
                              <label className="shrink-0 text-xs font-medium text-zinc-700">
                                预期结果
                              </label>
                              <textarea
                                className="mt-1.5 min-h-[240px] flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed"
                                value={caseActualResult}
                                onChange={(e) =>
                                  setCaseActualResult(e.target.value)
                                }
                              />
                            </div>
                            <div className="flex min-h-0 flex-col">
                              <label className="shrink-0 text-xs font-medium text-zinc-700">
                                备注
                              </label>
                              <textarea
                                className="mt-1.5 min-h-[240px] flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed"
                                value={caseRemark}
                                onChange={(e) => setCaseRemark(e.target.value)}
                              />
                            </div>
                          </div>
                        )}
                      </section>

                      {embedMode && executionTaskId ? (
                        <section className="rounded-xl border border-transparent bg-transparent p-0">
                          <h4 className="text-sm font-semibold text-zinc-800">
                            执行结果（仅本执行任务）
                          </h4>
                          {execResultUpdatedIso ? (
                            <div className="mt-1 text-xs text-zinc-500 tabular-nums">
                              最近更新：{formatTs(execResultUpdatedIso)}
                            </div>
                          ) : null}
                          <textarea
                            className="mt-2 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed"
                            style={{ height: `${execResultTextareaHeight}px` }}
                            placeholder="例如：本轮执行的实际结果、截图/日志链接、备注等"
                            value={execResult}
                            onChange={(e) => setExecResult(e.target.value)}
                            onMouseUp={(e) =>
                              setExecResultTextareaHeight(
                                clampExecResultHeight(
                                  e.currentTarget.getBoundingClientRect().height,
                                ),
                              )
                            }
                            onPaste={onPasteExecResult}
                          />
                          {execRunImages.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {execRunImages.map((img) => (
                                <button
                                  key={img.id}
                                  type="button"
                                  className="rounded-md border border-zinc-200 bg-white p-1 hover:bg-zinc-50"
                                  onClick={() => setExecRunImageOpen(img.dataUrl)}
                                  title="点击查看大图"
                                >
                                  <img
                                    src={img.dataUrl}
                                    alt="截图预览"
                                    className="h-16 w-24 object-cover"
                                  />
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </section>
                      ) : null}
                    </div>

                    <section className="rounded-xl border border-transparent bg-transparent p-0">
                      <div className="space-y-3">
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            用例库（文件夹）
                          </label>
                          <select
                            className={[
                              "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm",
                              metaFieldCls,
                            ].join(" ")}
                            disabled={embedTaskMetaLocked}
                            value={folderId}
                            onChange={(e) => setFolderId(e.target.value)}
                          >
                            {folders.map((f) => (
                              <option key={f.id} value={f.id}>
                                {folderPathFromFlat(f.id, folders)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            用例等级
                          </label>
                          <CaseLevelSelect
                            className={[
                              "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm",
                              metaFieldCls,
                            ].join(" ")}
                            disabled={embedTaskMetaLocked}
                            value={priority}
                            onChange={(v) => setPriority(v)}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            维护人
                          </label>
                          <input
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                            value={maintainer}
                            onChange={(e) => setMaintainer(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            状态
                          </label>
                          <select
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                            value={status}
                            onChange={(e) =>
                              setStatus(e.target.value as TestCaseStatus | "")
                            }
                          >
                            <option value="">（未选择）</option>
                            {testCaseStatusOptions.map((o) => (
                              <option
                                key={o.value}
                                value={o.value}
                                style={testCaseStatusSelectOptionStyle[o.value]}
                              >
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            {embedTaskMetaLocked ? "创建人" : "提交人"}
                          </label>
                          <input
                            className={[
                              "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm",
                              metaFieldCls,
                            ].join(" ")}
                            disabled={embedTaskMetaLocked}
                            value={submitter}
                            onChange={(e) => setSubmitter(e.target.value)}
                          />
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              ) : caseModalTab === "defects" ? (
                !editingId ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                    保存用例后，可在此管理已关联缺陷并搜索添加新关联。
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="rounded-lg border border-zinc-200 bg-white">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2">
                        <div className="text-xs font-medium text-zinc-600">
                          已关联缺陷（{modalLinkedDefects.length} 条）
                        </div>
                        {modalLinkedDefects.length > 0 ? (
                          <button
                            type="button"
                            disabled={
                              defectLinkBusy ||
                              modalLinkedDefectPickIds.length === 0
                            }
                            className="rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                            onClick={() =>
                              void removeSelectedModalLinkedDefects()
                            }
                          >
                            {modalLinkedDefectPickIds.length > 0
                              ? `批量移除（${modalLinkedDefectPickIds.length}）`
                              : "批量移除"}
                          </button>
                        ) : null}
                      </div>
                      <div className="max-h-[360px] overflow-auto">
                        {modalLinkedDefects.length === 0 ? (
                          <div className="px-3 py-3 text-sm text-zinc-500">
                            暂无关联。请在下方列表中勾选缺陷后「关联已选」。
                          </div>
                        ) : (
                          <table className="w-full min-w-[560px] table-fixed text-sm">
                            <colgroup>
                              <col style={{ width: modalLinkedTblChkW }} />
                              <col style={{ width: modalLinkedTblNoW }} />
                              <col style={{ width: modalLinkedTblNameW }} />
                              <col style={{ width: modalLinkedTblStatusW }} />
                              <col style={{ width: 72 }} />
                            </colgroup>
                            <thead className="bg-zinc-50 text-xs text-zinc-500">
                              <tr>
                                <th className="relative px-2 py-2 text-left">
                                  <input
                                    ref={modalLinkedDefectSelectAllRef}
                                    type="checkbox"
                                    className="h-3.5 w-3.5 rounded border-zinc-300"
                                    aria-label="全选已关联缺陷"
                                    onChange={() =>
                                      toggleModalLinkedDefectPickAll()
                                    }
                                  />
                                  <TableColumnResizeHandle
                                    onResizeStart={
                                      startResizeModalLinkedChkVsNo
                                    }
                                  />
                                </th>
                                <th className="relative px-3 py-2 text-left">
                                  缺陷编号
                                  <TableColumnResizeHandle
                                    onResizeStart={
                                      startResizeModalLinkedNoVsName
                                    }
                                  />
                                </th>
                                <th className="relative px-3 py-2 text-left">
                                  名称
                                  <TableColumnResizeHandle
                                    onResizeStart={
                                      startResizeModalLinkedNameVsStatus
                                    }
                                  />
                                </th>
                                <th className="relative px-3 py-2 text-left">
                                  状态
                                  <TableColumnResizeHandle
                                    onResizeStart={
                                      startResizeModalLinkedStatusVsOp
                                    }
                                  />
                                </th>
                                <th className="px-3 py-2 text-right">操作</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-100">
                              {modalLinkedDefects.map((d) => {
                                const st = d.status as DefectStatus;
                                return (
                                  <tr key={d.id} className="hover:bg-zinc-50/70">
                                    <td className="px-2 py-2 align-top">
                                      <input
                                        type="checkbox"
                                        className="h-3.5 w-3.5 rounded border-zinc-300"
                                        checked={modalLinkedDefectPickSet.has(
                                          d.id,
                                        )}
                                        aria-label={`选择缺陷 ${d.defectNo}`}
                                        onChange={() =>
                                          toggleModalLinkedDefectPick(d.id)
                                        }
                                      />
                                    </td>
                                    <td className="px-3 py-2 align-top font-mono text-xs text-zinc-700">
                                      {d.defectNo}
                                    </td>
                                    <td className="max-w-0 px-3 py-2 align-top text-zinc-800">
                                      <div className="truncate" title={d.name}>
                                        {d.name}
                                      </div>
                                    </td>
                                    <td className="px-3 py-2 align-top">
                                      <span
                                        className={[
                                          "inline-flex max-w-full rounded-full border px-2 py-0.5 text-xs font-medium",
                                          defectModalStatusBadge[st] ??
                                            "border-zinc-200 bg-zinc-50 text-zinc-700",
                                        ].join(" ")}
                                      >
                                        {defectModalStatusLabel[st] ?? d.status}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-right align-top">
                                      <button
                                        type="button"
                                        disabled={defectLinkBusy}
                                        className="text-xs text-red-700 hover:underline disabled:opacity-50"
                                        onClick={() =>
                                          void removeDefectFromCase(d.id)
                                        }
                                      >
                                        移除
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>

                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        待关联缺陷
                      </h4>
                      <p className="mt-1 text-xs text-zinc-500">
                        先选迭代：下方默认列出该迭代下可选缺陷（已关联的会隐藏）；可用搜索缩小范围。勾选后点「关联已选」批量关联。
                      </p>
                      <div
                        className="mt-3 space-y-3"
                        id="test-case-modal-defect-link-root"
                      >
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-[220px] flex-1">
                            <label className="text-[11px] font-medium text-zinc-500">
                              迭代筛选
                            </label>
                            <select
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                              value={addDefectIterCode}
                              onChange={(e) =>
                                setAddDefectIterCode(e.target.value)
                              }
                            >
                              {iterationOptions.map((o) => (
                                <option
                                  key={o.code || "__baseline__"}
                                  value={o.code}
                                >
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            disabled={
                              defectLinkBusy || addDefectPickIds.length === 0
                            }
                            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                            onClick={() => void addSelectedDefectsToCase()}
                          >
                            {addDefectPickIds.length > 0
                              ? `关联已选（${addDefectPickIds.length}）`
                              : "关联已选"}
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                            onClick={() => {
                              setAddDefectIterCode("");
                              setAddDefectQuery("");
                              setAddDefectPickIds([]);
                            }}
                          >
                            重置
                          </button>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-zinc-600">
                            搜索缺陷
                          </label>
                          <input
                            type="search"
                            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                            value={addDefectQuery}
                            onChange={(e) => setAddDefectQuery(e.target.value)}
                            placeholder="按编号 / 名称筛选（留空则显示当前迭代下最多 200 条）"
                          />
                        </div>
                        <div className="rounded-lg border border-zinc-200 bg-white">
                          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                            <span>
                              可选缺陷（未关联 {pendingDefectRows.length} 条 / 本轮最多
                              200 条，按更新时间倒序）
                            </span>
                            <span>{addDefectLoading ? "加载中…" : ""}</span>
                          </div>
                          <div className="max-h-[320px] overflow-auto">
                            {pendingDefectRows.length === 0 ? (
                              <div className="px-3 py-3 text-sm text-zinc-500">
                                {addDefectLoading
                                  ? "加载中…"
                                  : "暂无可用缺陷（可能均已关联，或当前迭代下无匹配）。"}
                              </div>
                            ) : (
                              <table className="w-full min-w-[400px] table-fixed text-sm">
                                <colgroup>
                                  <col style={{ width: addDefectTblChkW }} />
                                  <col style={{ width: addDefectTblNoW }} />
                                  <col />
                                </colgroup>
                                <thead className="sticky top-0 z-[1] border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                                  <tr>
                                    <th className="relative px-2 py-2 text-left font-medium">
                                      <input
                                        ref={addDefectSelectAllRef}
                                        type="checkbox"
                                        className="h-3.5 w-3.5 rounded border-zinc-300"
                                        aria-label="全选当前列表"
                                        disabled={defectLinkBusy}
                                        onChange={() =>
                                          toggleAddDefectPickAll()
                                        }
                                      />
                                      <TableColumnResizeHandle
                                        onResizeStart={
                                          startResizeAddDefectChkVsNo
                                        }
                                      />
                                    </th>
                                    <th className="relative px-2 py-2 text-left font-medium">
                                      编号
                                      <TableColumnResizeHandle
                                        onResizeStart={
                                          startResizeAddDefectNoVsName
                                        }
                                      />
                                    </th>
                                    <th className="px-2 py-2 text-left font-medium">
                                      名称
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-100">
                                  {pendingDefectRows.map((d) => (
                                    <tr
                                      key={d.id}
                                      className={[
                                        "hover:bg-zinc-50/70",
                                        defectLinkBusy
                                          ? "pointer-events-none opacity-50"
                                          : "",
                                      ].join(" ")}
                                    >
                                      <td className="px-2 py-2 align-middle">
                                        <input
                                          type="checkbox"
                                          className="h-3.5 w-3.5 rounded border-zinc-300"
                                          disabled={defectLinkBusy}
                                          checked={addDefectPickSet.has(d.id)}
                                          aria-label={`选择缺陷 ${d.defectNo}`}
                                          onChange={() =>
                                            toggleAddDefectPick(d.id)
                                          }
                                        />
                                      </td>
                                      <td className="px-2 py-2 font-mono text-xs text-zinc-700">
                                        {d.defectNo}
                                      </td>
                                      <td className="px-2 py-2 text-zinc-800">
                                        <div className="truncate">{d.name}</div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              ) : caseModalTab === "execRuns" ? (
                !editingId ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                    保存用例后可在此记录每次执行的时间、状态与执行人。
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-zinc-200 bg-white">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2">
                        <span className="text-xs font-medium text-zinc-600">
                          历史记录（
                          {embedMode ? execRecords.length : allExecRecords.length}{" "}
                          条）
                        </span>
                        {editingId ? (
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                            onClick={() => {
                              setExecRestorePick([]);
                              setExecRestoreOpen(true);
                            }}
                          >
                            恢复执行记录
                          </button>
                        ) : null}
                      </div>
                      <div className="max-h-[480px] overflow-auto">
                        {(embedMode ? execRecords.length === 0 : allExecRecords.length === 0) ? (
                          <div className="px-3 py-3 text-sm text-zinc-500">
                            暂无执行记录。
                          </div>
                        ) : (
                          <table className="w-full min-w-[560px] table-fixed text-sm">
                            <thead className="sticky top-0 z-[1] bg-zinc-50 text-xs text-zinc-500">
                              <tr>
                                <th className="w-44 px-3 py-2 text-left">时间</th>
                                <th className="w-28 px-3 py-2 text-left">状态</th>
                                <th className="w-32 px-3 py-2 text-left">执行人</th>
                                {!embedMode ? (
                                  <th className="w-56 px-3 py-2 text-left">执行任务</th>
                                ) : null}
                                <th className="w-24 px-3 py-2 text-left">详情</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-100">
                              {embedMode
                                ? execRecords.map((r) => (
                                    <tr key={r.id} className="hover:bg-zinc-50/70">
                                      <td className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums">
                                        {formatTs(r.executedAt)}
                                      </td>
                                      <td className="px-3 py-2 align-top text-xs">
                                        <span
                                          className={[
                                            "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium",
                                            testCaseStatusBadgeClass[r.status],
                                          ].join(" ")}
                                        >
                                          {testCaseStatusLabel[r.status]}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2 align-top text-xs text-zinc-700">
                                        {r.executor?.trim() ? r.executor : "—"}
                                      </td>
                                      <td className="px-3 py-2 align-top">
                                        <div className="flex flex-wrap gap-1">
                                          <button
                                            type="button"
                                            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                            onClick={() =>
                                              setExecRecordDetailOpen({
                                                executedAt: r.executedAt,
                                                status: r.status,
                                                executor: r.executor,
                                                result: r.result ?? null,
                                                images: r.images ?? null,
                                                note: r.note ?? null,
                                              })
                                            }
                                          >
                                            查看
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))
                                : allExecRecords.map((r) => (
                                    <tr key={r.id} className="hover:bg-zinc-50/70">
                                      <td className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums">
                                        {formatTs(r.executedAt)}
                                      </td>
                                      <td className="px-3 py-2 align-top text-xs">
                                        <span
                                          className={[
                                            "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium",
                                            testCaseStatusBadgeClass[r.status],
                                          ].join(" ")}
                                        >
                                          {testCaseStatusLabel[r.status]}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2 align-top text-xs text-zinc-700">
                                        {r.executor?.trim() ? r.executor : "—"}
                                      </td>
                                      <td className="px-3 py-2 align-top text-xs text-zinc-700">
                                        {r.executionTaskTitle?.trim()
                                          ? r.executionTaskTitle
                                          : "—"}
                                      </td>
                                      <td className="px-3 py-2 align-top">
                                        <div className="flex flex-wrap gap-1">
                                          <button
                                            type="button"
                                            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                            onClick={() =>
                                              setExecRecordDetailOpen({
                                                executedAt: r.executedAt,
                                                status: r.status,
                                                executor: r.executor,
                                                result: r.result ?? null,
                                                images: r.images ?? null,
                                                note: r.note ?? null,
                                                executionTaskTitle:
                                                  r.executionTaskTitle ?? null,
                                              })
                                            }
                                          >
                                            查看
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  </div>
                )
              ) : (
                <div className="rounded-lg border border-zinc-200 bg-white">
                  <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600">
                    操作记录（最近 {modalCaseOpLogs.length} 条）
                  </div>
                  <div className="max-h-[520px] overflow-auto">
                    {!editingId ? (
                      <div className="px-3 py-3 text-sm text-zinc-500">
                        新建用例尚无操作记录；保存后可查看。
                      </div>
                    ) : modalCaseOpLogs.length === 0 ? (
                      <div className="px-3 py-3 text-sm text-zinc-500">
                        暂无记录。
                      </div>
                    ) : (
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-zinc-50 text-xs text-zinc-500">
                          <tr>
                            <th className="w-40 px-3 py-2 text-left">时间</th>
                            <th className="w-40 px-3 py-2 text-left">动作</th>
                            <th className="px-3 py-2 text-left">说明</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                          {modalCaseOpLogs.map((x) => (
                            <tr key={x.id} className="hover:bg-zinc-50/70">
                              <td className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums">
                                {formatTs(x.createdAt)}
                              </td>
                              <td className="px-3 py-2 align-top font-mono text-[11px] text-zinc-600">
                                {x.action}
                              </td>
                              <td className="max-w-0 px-3 py-2 align-top whitespace-pre-wrap break-words text-xs text-zinc-700">
                                {x.detail ?? "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-zinc-100 px-6 py-4">
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                  onClick={() => {
                    setModalOpen(false);
                    if (embedMode) onEmbedClose?.();
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={saving}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                  onClick={submitCase}
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {restoreArchiveOpen ? (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center overflow-y-auto bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-archive-title"
          onClick={() => setRestoreArchiveOpen(false)}
        >
          <div
            className="mb-8 w-full max-w-3xl rounded-xl border border-zinc-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h3
                id="restore-archive-title"
                className="text-lg font-semibold text-zinc-900"
              >
                恢复今日删除的用例
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                列表来自删除时写入的归档表（最多展示 500 条）。勾选后恢复为用例库数据，并尽力重建与测试设计 / 缺陷 /
                执行任务的关联（对方若已删除则跳过）。
                <strong className="font-medium text-zinc-800">
                  「执行任务」节点删除不会进入此归档，须依赖数据库备份找回。
                </strong>
              </p>
              <div className="mt-4">
                <label className="text-xs font-medium text-zinc-600">
                  原目录已删除时，恢复到
                </label>
                <select
                  className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                  value={restoreFallbackFolderId}
                  onChange={(e) => setRestoreFallbackFolderId(e.target.value)}
                  title="当归档中的文件夹已不存在时，用例会放入此目录；原目录仍在时仍恢复到原目录"
                >
                  {folders.length === 0 ? (
                    <option value="">（无目录，请先在侧栏维护文件夹）</option>
                  ) : (
                    folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {folderPathFromFlat(f.id, folders)}
                      </option>
                    ))
                  )}
                </select>
                <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                  若归档里的目标文件夹仍存在，会优先恢复到原目录；仅当原目录已删时，才使用上面选择的目录。
                </p>
              </div>
            </div>
            <div className="max-h-[min(60vh,520px)] overflow-auto px-5 py-3">
              {restoreArchiveRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">
                  今日尚无删除归档，或归档已被恢复。
                </p>
              ) : (
                <table className="w-full min-w-[560px] table-fixed text-sm">
                  <thead className="sticky top-0 border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                    <tr>
                      <th className="w-10 px-2 py-2 text-left font-medium">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-zinc-300"
                          aria-label="全选归档"
                          checked={
                            restoreArchiveRows.length > 0 &&
                            restoreArchivePick.length === restoreArchiveRows.length
                          }
                          onChange={() => {
                            setRestoreArchivePick((prev) => {
                              if (
                                prev.length === restoreArchiveRows.length &&
                                restoreArchiveRows.length > 0
                              )
                                return [];
                              return restoreArchiveRows.map((x) => x.id);
                            });
                          }}
                        />
                      </th>
                      <th className="px-2 py-2 text-left font-medium">删除时间</th>
                      <th className="px-2 py-2 text-left font-medium">编号</th>
                      <th className="px-2 py-2 text-left font-medium">名称</th>
                      <th className="px-2 py-2 text-left font-medium">目录</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {restoreArchiveRows.map((r) => (
                      <tr key={r.id} className="hover:bg-zinc-50/70">
                        <td className="px-2 py-2 align-top">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-zinc-300"
                            checked={restoreArchivePick.includes(r.id)}
                            onChange={() =>
                              setRestoreArchivePick((prev) =>
                                prev.includes(r.id)
                                  ? prev.filter((x) => x !== r.id)
                                  : [...prev, r.id],
                              )
                            }
                            aria-label={`选择 ${r.caseNo}`}
                          />
                        </td>
                        <td className="px-2 py-2 align-top text-xs text-zinc-600 tabular-nums">
                          {formatTs(r.deletedAt)}
                        </td>
                        <td className="px-2 py-2 align-top font-mono text-xs text-zinc-800">
                          {r.caseNo}
                        </td>
                        <td className="max-w-0 px-2 py-2 align-top">
                          <div className="truncate" title={r.title}>
                            {r.title}
                          </div>
                        </td>
                        <td className="max-w-0 px-2 py-2 align-top text-xs text-zinc-500">
                          <div className="truncate" title={r.folderId}>
                            {folderPathFromFlat(r.folderId, folders)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-100 px-5 py-4">
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                disabled={restoreArchiveWorking}
                onClick={() => setRestoreArchiveOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                disabled={
                  restoreArchiveWorking ||
                  restoreArchivePick.length === 0 ||
                  restoreArchiveRows.length === 0
                }
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                onClick={() => void runRestoreFromArchive()}
              >
                {restoreArchiveWorking
                  ? "恢复中…"
                  : restoreArchivePick.length > 0
                    ? `恢复已选（${restoreArchivePick.length}）`
                    : "恢复已选"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {execRestoreOpen ? (
        <div
          className="fixed inset-0 z-[96] flex items-center justify-center overflow-y-auto bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="exec-restore-title"
          onClick={() => setExecRestoreOpen(false)}
        >
          <div
            className="mb-8 w-full max-w-3xl rounded-xl border border-zinc-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h3
                id="exec-restore-title"
                className="text-lg font-semibold text-zinc-900"
              >
                恢复执行记录
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                下列条目来源于在本弹窗内删除执行记录时写入的误删归档。勾选后可恢复到对应执行任务下的历史记录。
              </p>
            </div>
            <div className="max-h-[min(55vh,480px)] overflow-auto px-5 py-3">
              {execRestoreLoading ? (
                <p className="py-8 text-center text-sm text-zinc-500">
                  加载中…
                </p>
              ) : deletedExecRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">
                  当前用例暂无待恢复的执行记录归档。
                </p>
              ) : (
                <table className="w-full min-w-[560px] table-fixed text-sm">
                  <thead className="sticky top-0 border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                    <tr>
                      <th className="w-10 px-2 py-2 text-left font-medium">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-zinc-300"
                          aria-label="全选误删执行记录"
                          checked={
                            deletedExecRows.length > 0 &&
                            execRestorePick.length === deletedExecRows.length
                          }
                          onChange={() => {
                            setExecRestorePick((prev) => {
                              if (
                                prev.length === deletedExecRows.length &&
                                deletedExecRows.length > 0
                              )
                                return [];
                              return deletedExecRows.map((x) => x.archiveId);
                            });
                          }}
                        />
                      </th>
                      <th className="px-2 py-2 text-left font-medium">
                        删除时间
                      </th>
                      <th className="px-2 py-2 text-left font-medium">
                        执行时间
                      </th>
                      <th className="px-2 py-2 text-left font-medium">
                        执行任务
                      </th>
                      <th className="w-24 px-2 py-2 text-left font-medium">
                        状态
                      </th>
                      <th className="px-2 py-2 text-left font-medium">
                        执行人
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {deletedExecRows.map((r) => (
                      <tr key={r.archiveId} className="hover:bg-zinc-50/70">
                        <td className="px-2 py-2 align-top">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-zinc-300"
                            checked={execRestorePick.includes(r.archiveId)}
                            onChange={() =>
                              setExecRestorePick((prev) =>
                                prev.includes(r.archiveId)
                                  ? prev.filter((x) => x !== r.archiveId)
                                  : [...prev, r.archiveId],
                              )
                            }
                            aria-label={`选择归档 ${r.archiveId.slice(0, 8)}`}
                          />
                        </td>
                        <td className="px-2 py-2 align-top text-xs text-zinc-600 tabular-nums">
                          {formatTs(r.deletedAt)}
                        </td>
                        <td className="px-2 py-2 align-top text-xs text-zinc-600 tabular-nums">
                          {formatTs(r.executedAt)}
                        </td>
                        <td className="max-w-0 px-2 py-2 align-top text-xs text-zinc-800">
                          <div className="truncate" title={r.executionTaskTitle ?? ""}>
                            {r.executionTaskTitle?.trim()
                              ? r.executionTaskTitle
                              : r.executionTaskId}
                          </div>
                        </td>
                        <td className="px-2 py-2 align-top text-xs">
                          <span
                            className={[
                              "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium",
                              testCaseStatusBadgeClass[r.status],
                            ].join(" ")}
                          >
                            {testCaseStatusLabel[r.status]}
                          </span>
                        </td>
                        <td className="px-2 py-2 align-top text-xs text-zinc-700">
                          {r.executor?.trim() ? r.executor : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-100 px-5 py-4">
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                disabled={execRestoreWorking}
                onClick={() => setExecRestoreOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                disabled={
                  execRestoreWorking ||
                  execRestorePick.length === 0 ||
                  deletedExecRows.length === 0
                }
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                onClick={() => void runRestoreExecRecords()}
              >
                {execRestoreWorking
                  ? "恢复中…"
                  : execRestorePick.length > 0
                    ? `恢复已选（${execRestorePick.length}）`
                    : "恢复已选"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {batchExportOpen ? (
        <div className="fixed inset-0 z-[92] flex items-center justify-center overflow-y-auto bg-black/45 p-4">
          <div
            className="mb-8 w-full max-w-lg rounded-2xl border border-zinc-200 bg-white shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="case-lib-batch-export-title"
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
              <div>
                <div
                  id="case-lib-batch-export-title"
                  className="text-sm font-semibold text-zinc-900"
                >
                  批量导出 CSV
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  已选{" "}
                  <strong className="tabular-nums text-zinc-700">
                    {selectedCaseIds.length}
                  </strong>{" "}
                  条用例；勾选需要写入 CSV 的字段。
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                onClick={() => setBatchExportOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="px-5 py-4">
              <div className="mb-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  onClick={() =>
                    setExportFieldSel({ ...DEFAULT_TEST_CASE_EXPORT_FIELDS })
                  }
                >
                  全选
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  onClick={() =>
                    setExportFieldSel(
                      Object.fromEntries(
                        TEST_CASE_EXPORT_COLUMN_KEYS.map((k) => [k, false]),
                      ) as Record<TestCaseExportColumnKey, boolean>,
                    )
                  }
                >
                  全不选
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  onClick={() =>
                    setExportFieldSel({ ...DEFAULT_TEST_CASE_EXPORT_FIELDS })
                  }
                >
                  恢复默认
                </button>
              </div>
              <ul className="max-h-[min(52vh,22rem)] space-y-1 overflow-y-auto rounded-lg border border-zinc-100 bg-zinc-50/50 p-2">
                {TEST_CASE_EXPORT_COLUMN_KEYS.map((key) => (
                  <li
                    key={key}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white"
                  >
                    <input
                      id={`export-field-${key}`}
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded border-zinc-300"
                      checked={exportFieldSel[key]}
                      onChange={(e) =>
                        setExportFieldSel((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                    />
                    <label
                      htmlFor={`export-field-${key}`}
                      className="min-w-0 flex-1 cursor-pointer text-sm text-zinc-800"
                    >
                      {TEST_CASE_EXPORT_COLUMN_LABELS[key]}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  disabled={batchWorking}
                  onClick={() => setBatchExportOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  disabled={
                    batchWorking ||
                    !TEST_CASE_EXPORT_COLUMN_KEYS.some((k) => exportFieldSel[k])
                  }
                  onClick={() => void runBatchExport()}
                >
                  {batchWorking ? "导出中…" : "确认导出"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {batchEditOpen ? (
        <div className="fixed inset-0 z-[92] flex items-center justify-center overflow-y-auto bg-black/45 p-4">
          <div
            className="mb-8 w-full max-w-lg rounded-2xl border border-zinc-200 bg-white shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="case-lib-batch-edit-title"
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
              <div>
                <div
                  id="case-lib-batch-edit-title"
                  className="text-sm font-semibold text-zinc-900"
                >
                  批量修改用例
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  将写入用例库中对应用例；仅当前勾选的条目会更新（状态可选「清空」）。
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                onClick={() => setBatchEditOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div>
                <label className="text-xs font-medium text-zinc-600">状态</label>
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                  value={batchStatusSel}
                  onChange={(e) => setBatchStatusSel(e.target.value)}
                >
                  <option value="keep">（不修改）</option>
                  <option value="clear">（清空）</option>
                  {testCaseStatusOptions.map((o) => (
                    <option
                      key={o.value}
                      value={o.value}
                      style={testCaseStatusSelectOptionStyle[o.value]}
                    >
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-zinc-600">用例等级</label>
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                  value={batchPrioritySel}
                  onChange={(e) => setBatchPrioritySel(e.target.value)}
                >
                  <option value="keep">（不修改）</option>
                  <option value="unset">未设置</option>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <option key={n} value={String(n)}>
                      L{n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                    checked={batchMaintainerApply}
                    onChange={(e) => setBatchMaintainerApply(e.target.checked)}
                  />
                  更新维护人
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-100"
                  disabled={!batchMaintainerApply}
                  value={batchMaintainerText}
                  onChange={(e) => setBatchMaintainerText(e.target.value)}
                  placeholder={
                    batchMaintainerApply ? "留空则清空维护人" : "先勾选「更新维护人」"
                  }
                />
              </div>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                    checked={batchSubmitterApply}
                    onChange={(e) => setBatchSubmitterApply(e.target.checked)}
                  />
                  更新提交人
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-100"
                  disabled={!batchSubmitterApply}
                  value={batchSubmitterText}
                  onChange={(e) => setBatchSubmitterText(e.target.value)}
                  placeholder={
                    batchSubmitterApply ? "留空则清空提交人" : "先勾选「更新提交人」"
                  }
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  disabled={batchEditWorking}
                  onClick={() => setBatchEditOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                  disabled={
                    batchEditWorking || selectedCaseIds.length === 0
                  }
                  onClick={() => void runBatchEditMeta()}
                >
                  {batchEditWorking ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {moveModalOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-move-title"
        >
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl">
            <h3
              id="batch-move-title"
              className="text-lg font-semibold text-zinc-900"
            >
              批量移动
            </h3>
            <p className="mt-2 text-sm text-zinc-600">
              将已勾选的{" "}
              <strong className="tabular-nums">{selectedCaseIds.length}</strong>{" "}
              条用例移动到目标文件夹（仍在用例库内）。
            </p>
            <label className="mt-4 block text-xs font-medium text-zinc-600">
              目标文件夹
            </label>
            <select
              className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              value={moveTargetFolderId}
              onChange={(e) => setMoveTargetFolderId(e.target.value)}
            >
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {folderPathFromFlat(f.id, folders)}
                </option>
              ))}
            </select>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                onClick={() => setMoveModalOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={batchWorking || !moveTargetFolderId}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                onClick={runBatchMove}
              >
                {batchWorking ? "处理中…" : "确定移动"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {folderNameModal ? (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-name-modal-title"
          onClick={() => setFolderNameModal(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="folder-name-modal-title"
              className="text-base font-semibold text-zinc-900"
            >
              {folderNameModal.mode === "newChild"
                ? "新建子文件夹"
                : folderNameModal.mode === "rename"
                  ? "重命名文件夹"
                  : "新建根文件夹"}
            </h2>
            <label className="mt-3 block text-xs font-medium text-zinc-600">
              名称
            </label>
            <input
              ref={folderNameInputRef}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              value={folderNameDraft}
              onChange={(e) => setFolderNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitFolderNameModal();
              }}
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                onClick={() => setFolderNameModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800"
                onClick={() => void submitFolderNameModal()}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {noticeDialog ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="notice-dialog-title"
          aria-describedby="notice-dialog-detail"
        >
          <div className="max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl">
            <h2
              id="notice-dialog-title"
              className="text-lg font-semibold text-zinc-900"
            >
              {noticeDialog.title}
            </h2>
            <p
              id="notice-dialog-detail"
              className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600"
            >
              {noticeDialog.detail}
            </p>
            <button
              type="button"
              className="mt-6 w-full rounded-lg bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
              onClick={() => setNoticeDialog(null)}
            >
              确定
            </button>
          </div>
        </div>
      ) : null}

      {execRunImageOpen ? (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="截图预览"
          onClick={() => setExecRunImageOpen(null)}
        >
          <div className="max-h-[92vh] max-w-[92vw]">
            <img
              src={execRunImageOpen}
              alt="截图大图"
              className="max-h-[92vh] max-w-[92vw] rounded-lg border border-white/10 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      ) : null}

      {execRecordDetailOpen ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="执行记录详情"
          onClick={() => setExecRecordDetailOpen(null)}
        >
          <div
            className="w-full max-w-3xl rounded-xl border border-zinc-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <div className="text-sm font-semibold text-zinc-900">执行记录详情</div>
              <div className="mt-1 text-xs text-zinc-500 tabular-nums">
                时间：{formatTs(execRecordDetailOpen.executedAt)}{" "}
                {execRecordDetailOpen.executionTaskTitle ? (
                  <span className="ml-3">
                    执行任务：{execRecordDetailOpen.executionTaskTitle}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-4">
              <div className="text-xs text-zinc-600">
                执行人：{execRecordDetailOpen.executor?.trim() ? execRecordDetailOpen.executor : "—"}
              </div>
              <div>
                <div className="text-xs font-medium text-zinc-700">执行结果</div>
                <div className="mt-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm whitespace-pre-wrap break-words text-zinc-800 min-h-[80px]">
                  {execRecordDetailOpen.result?.trim() ? execRecordDetailOpen.result : "—"}
                </div>
              </div>
              {Array.isArray(execRecordDetailOpen.images) && execRecordDetailOpen.images.length > 0 ? (
                <div>
                  <div className="text-xs font-medium text-zinc-700">截图</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(execRecordDetailOpen.images as unknown[]).slice(0, 12).map((u, i) => (
                      typeof u === "string" ? (
                        <button
                          key={String(i)}
                          type="button"
                          className="rounded-md border border-zinc-200 bg-white p-1 hover:bg-zinc-50"
                          onClick={() => setExecRunImageOpen(u)}
                          title="点击查看大图"
                        >
                          <img src={u} alt="截图预览" className="h-16 w-24 object-cover" />
                        </button>
                      ) : null
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="border-t border-zinc-100 px-5 py-3">
              <button
                type="button"
                className="w-full rounded-lg bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
                onClick={() => setExecRecordDetailOpen(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
