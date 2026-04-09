"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "产品管理" },
  { href: "/iterations", label: "迭代管理" },
  { href: "/requirements", label: "需求管理" },
  { href: "/test-design", label: "测试设计" },
  { href: "/test-cases", label: "测试用例库" },
  { href: "/defects", label: "缺陷管理" },
  { href: "/executions", label: "执行任务" },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-950 text-zinc-100">
        <div className="border-b border-zinc-800 px-4 py-4">
          <div className="text-sm font-semibold tracking-tight">研发质量台</div>
          <div className="mt-0.5 text-xs text-zinc-400">产品与测试协同</div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {navItems.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
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
      <main className="min-h-screen flex-1 overflow-auto">{children}</main>
    </div>
  );
}
