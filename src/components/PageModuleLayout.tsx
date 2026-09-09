import type { ReactNode } from "react";

/** 与「测试用例库」等模块统一的页眉标题与说明 */
export function ModulePageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold text-zinc-900">{title}</h1>
      <p className="mb-6 text-sm text-zinc-600">{description}</p>
    </>
  );
}

/** 主工作区白底圆角卡片（与用例库外层一致） */
export function ModuleWorkspaceCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        "overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

/** 模块内工具栏：次要操作（高级筛选、列设置 ⚙） */
export const MODULE_TOOLBAR_BTN_SECONDARY =
  "rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-700 shadow-sm hover:bg-zinc-50";

/** 模块内工具栏：主操作（新建…） */
export const MODULE_TOOLBAR_BTN_PRIMARY =
  "rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40";
