"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Zap,
  LayoutDashboard,
  Plus,
  Clock,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/generate", label: "Nova Geração", icon: Plus },
  { href: "/history", label: "Histórico", icon: Clock },
  { href: "/settings", label: "Configurações", icon: Settings },
];

interface SidebarProps {
  user: { name?: string | null; email: string; image?: string | null };
}

export function DashboardSidebar({ user }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-white/[0.06] bg-white/[0.02] flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-6 border-b border-white/[0.06]">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white">MotionForge</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" &&
              pathname.startsWith(item.href + "/"));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                isActive
                  ? "bg-violet-500/10 text-violet-300 border border-violet-500/20"
                  : "text-white/50 hover:text-white hover:bg-white/[0.05]"
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="p-4 border-t border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center text-sm font-bold text-violet-300">
            {(user.name ?? user.email)[0].toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">
              {user.name ?? "Usuário"}
            </p>
            <p className="text-xs text-white/40 truncate">{user.email}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
