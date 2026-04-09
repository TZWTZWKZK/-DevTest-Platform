"use client";

import type { MouseEvent as ReactMouseEvent } from "react";

/** 表头列右侧边缘拖拽手柄，用于调整相邻列宽（需在 `relative` 的 `th` 内使用） */
export function TableColumnResizeHandle({
  onResizeStart,
  className = "",
}: {
  onResizeStart: (e: ReactMouseEvent) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      title="拖拽调整列宽"
      className={[
        "absolute right-0 top-0 z-[2] h-full w-2 -translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 hover:bg-sky-500/25",
        className,
      ].join(" ")}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onResizeStart(e);
      }}
    />
  );
}
