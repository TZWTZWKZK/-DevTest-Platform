"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "pm.sidebarCollapsed";

const navItems = [
  { href: "/", label: "产品管理" },
  { href: "/iterations", label: "迭代管理" },
  { href: "/requirements", label: "需求管理" },
  { href: "/test-design", label: "测试设计" },
  { href: "/test-cases", label: "测试用例库" },
  { href: "/defects", label: "缺陷管理" },
  { href: "/defect-analysis", label: "缺陷分析" },
  { href: "/executions", label: "执行任务" },
  { href: "/performance-analysis", label: "性能分析" },
  { href: "/executions/iteration-analysis", label: "迭代分析" },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
      if (v === "1") setCollapsed(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        collapsed ? "1" : "0",
      );
    } catch {
      // ignore
    }
  }, [collapsed]);

  const activeHref = useMemo(() => {
    const sorted = [...navItems].sort((a, b) => b.href.length - a.href.length);
    for (const item of sorted) {
      const active =
        item.href === "/"
          ? pathname === "/"
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (active) return item.href;
    }
    return null;
  }, [pathname]);

  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900">
      <aside
        className={[
          "relative flex shrink-0 flex-col bg-zinc-950 text-zinc-100 transition-[width] duration-200",
          collapsed ? "w-0 overflow-hidden border-r-0" : "w-56 border-r border-zinc-200",
        ].join(" ")}
        aria-label="侧边导航"
      >
        <div className="border-b border-zinc-800 px-4 py-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight">研发质量台</div>
              <div className="mt-0.5 text-xs text-zinc-400">产品与测试协同</div>
            </div>
            <button
              type="button"
              className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900 hover:text-white"
              onClick={() => setCollapsed(true)}
              aria-label="收起侧边栏"
              title="收起侧边栏"
            >
              ‹
            </button>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="导航菜单">
          {navItems.map((item) => {
            const active = activeHref === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  "rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-zinc-800 font-medium text-white"
                    : "text-zinc-300 hover:bg-zinc-900 hover:text-white",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="relative min-h-screen flex-1 overflow-auto">
        {collapsed ? (
          <button
            type="button"
            className="fixed left-2 top-2 z-50 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 shadow-sm hover:bg-zinc-50"
            onClick={() => setCollapsed(false)}
            aria-label="展开侧边栏"
            title={
              activeHref
                ? `展开侧边栏（当前：${navItems.find((x) => x.href === activeHref)?.label ?? "未知"}）`
                : "展开侧边栏"
            }
          >
            ›
          </button>
        ) : null}
        {children}
      </main>
    </div>
  );
}
