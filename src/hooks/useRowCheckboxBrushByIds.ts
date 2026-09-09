"use client";

import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

function readPmRowSelectIdUnderPoint(
  clientX: number,
  clientY: number,
): string | null {
  const nodes = document.elementsFromPoint(clientX, clientY);
  for (const n of nodes) {
    if (n instanceof Element) {
      const tr = n.closest("tr[data-pm-row-select]");
      if (tr instanceof HTMLElement) {
        const id = tr.dataset.pmRowSelect;
        if (id) return id;
      }
    }
  }
  return null;
}

export type RowCheckboxBrushByIdsParams = {
  /** 当前表格「可见行」id 顺序，与 DOM 中行顺序一致（通常为一页数据） */
  pagedRowIdsRef: RefObject<string[]>;
  /** 与当前勾选 id 列表同步（每轮渲染赋值），用于判断从「已勾选」还是「未勾选」格开始拖动 */
  selectedIdsRef: RefObject<readonly string[]>;
  setSelectedIds: Dispatch<SetStateAction<string[]>>;
};

/**
 * 与测试设计列表一致：在行复选框上按住左键拖动，按当前页顺序刷选；
 * 从未勾选的格开始拖：区间内加选；从已勾选的格开始拖：区间内去选；
 * 轻点仍切换单行；拖动结束后吞掉落在表体内的误触 click（避免进详情等）。
 */
export function useRowCheckboxBrushByIds({
  pagedRowIdsRef,
  selectedIdsRef,
  setSelectedIds,
}: RowCheckboxBrushByIdsParams) {
  const brushRef = useRef<{
    pointerId: number;
    anchorIdx: number;
    anchorId: string;
    /** true：从已勾选格按下，拖动为刷去勾选 */
    removeMode: boolean;
    drag: boolean;
    startX: number;
    startY: number;
    captureEl: HTMLInputElement | null;
  } | null>(null);
  const tableBodyRef = useRef<HTMLTableSectionElement | null>(null);
  const eatNextClickRef = useRef(false);

  const onRowCheckboxPointerDown = useCallback(
    (e: React.PointerEvent<HTMLInputElement>, rowId: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const ids = pagedRowIdsRef.current;
      const anchorIdx = ids.indexOf(rowId);
      if (anchorIdx < 0) return;
      e.preventDefault();
      const input = e.currentTarget;
      input.setPointerCapture(e.pointerId);
      const removeMode = selectedIdsRef.current.includes(rowId);
      brushRef.current = {
        pointerId: e.pointerId,
        anchorIdx,
        anchorId: rowId,
        removeMode,
        drag: false,
        startX: e.clientX,
        startY: e.clientY,
        captureEl: input,
      };
      const onMove = (ev: PointerEvent) => {
        const b = brushRef.current;
        if (!b || ev.pointerId !== b.pointerId) return;
        const dx = ev.clientX - b.startX;
        const dy = ev.clientY - b.startY;
        if (!b.drag && dx * dx + dy * dy > 36) b.drag = true;
        if (!b.drag) return;
        const over = readPmRowSelectIdUnderPoint(ev.clientX, ev.clientY);
        if (!over) return;
        const curIdx = pagedRowIdsRef.current.indexOf(over);
        if (curIdx < 0) return;
        const lo = Math.min(b.anchorIdx, curIdx);
        const hi = Math.max(b.anchorIdx, curIdx);
        const slice = pagedRowIdsRef.current.slice(lo, hi + 1);
        if (b.removeMode) {
          setSelectedIds((prev) => {
            const sliceSet = new Set(slice);
            return prev.filter((id) => !sliceSet.has(id));
          });
        } else {
          setSelectedIds((prev) => {
            const s = new Set(prev);
            for (const id of slice) s.add(id);
            return Array.from(s);
          });
        }
      };
      const onUp = (ev: PointerEvent) => {
        if (brushRef.current?.pointerId !== ev.pointerId) return;
        const b = brushRef.current;
        brushRef.current = null;
        if (b?.captureEl) {
          try {
            b.captureEl.releasePointerCapture(ev.pointerId);
          } catch {
            /* ignore */
          }
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (!b) return;
        if (!b.drag) {
          setSelectedIds((prev) =>
            prev.includes(b.anchorId)
              ? prev.filter((x) => x !== b.anchorId)
              : [...prev, b.anchorId],
          );
        } else {
          eatNextClickRef.current = true;
          const onDocClick = (ev: MouseEvent) => {
            if (!eatNextClickRef.current) {
              document.removeEventListener("click", onDocClick, true);
              return;
            }
            eatNextClickRef.current = false;
            document.removeEventListener("click", onDocClick, true);
            const body = tableBodyRef.current;
            if (body && ev.target instanceof Node && body.contains(ev.target)) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
            }
          };
          queueMicrotask(() => {
            document.addEventListener("click", onDocClick, true);
          });
          window.setTimeout(() => {
            document.removeEventListener("click", onDocClick, true);
            eatNextClickRef.current = false;
          }, 900);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [pagedRowIdsRef, selectedIdsRef, setSelectedIds],
  );

  return { onRowCheckboxPointerDown, tableBodyRef };
}
