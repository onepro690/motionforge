"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Zap,
  LayoutDashboard,
  Plus,
  Clock,
  Settings,
  Wand2,
  Merge,
  ImagePlus,
  Sun,
  Moon,
  ChevronUp,
  LayoutGrid,
  Sparkles,
  Youtube,
  TrendingUp,
  Radio,
  UserCircle,
  FileVideo,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const navItems = [
  { href: "/hub", label: "Início", icon: LayoutGrid },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/generate", label: "Motion Control", icon: Plus },
  { href: "/animate", label: "Animar por Texto", icon: Wand2 },
  { href: "/nanobanana", label: "Nano Banana", icon: ImagePlus },
  { href: "/join", label: "Juntar Vídeos", icon: Merge },
  { href: "/youtube", label: "YouTube DL", icon: Youtube },
  { href: "/history", label: "Histórico", icon: Clock },
];

const ugcNavItems = [
  { href: "/ugc", label: "Auto UGC", icon: TrendingUp },
  { href: "/ugc/products", label: "Produtos em Alta", icon: Sparkles },
  { href: "/ugc/generations", label: "Gerações", icon: Zap },
  { href: "/ugc/review", label: "Review", icon: LayoutDashboard },
  { href: "/ugc/lives", label: "Lives Shop", icon: Radio },
  { href: "/ugc/personagens", label: "Personagens", icon: UserCircle },
  { href: "/ugc/converter", label: "Conversor MP4", icon: FileVideo },
];

interface SidebarProps {
  user: { name?: string | null; email: string; image?: string | null };
}

export function DashboardSidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const isDark = theme === "dark";

  return (
    <aside className="w-64 border-r border-white/[0.06] bg-white/[0.02] mf-sidebar flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-6 border-b border-white/[0.06] mf-header">
        <Link href="/hub" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white mf-text-white">MotionForge</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
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
                "mf-sidebar-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                isActive
                  ? "mf-sidebar-item-active bg-violet-500/10 text-violet-300 border border-violet-500/20"
                  : "text-white/50 hover:text-white hover:bg-white/[0.05]"
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}

        {/* TikTok Shop Auto UGC Section */}
        <div className="pt-3 pb-1">
          <p className="text-[10px] uppercase tracking-widest text-white/20 px-3 mb-1">TikTok Shop</p>
        </div>
        {ugcNavItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/ugc" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "mf-sidebar-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
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

      {/* User dropdown */}
      <div className="p-4 border-t border-white/[0.06] mf-user-section">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="w-full flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.05] transition-colors group">
              <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center text-sm font-bold text-violet-300 flex-shrink-0">
                {(user.name ?? user.email)[0].toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="text-sm font-medium text-white mf-user-name truncate">
                  {user.name ?? "Usuário"}
                </p>
                <p className="text-xs text-white/40 mf-user-email truncate">{user.email}</p>
              </div>
              <ChevronUp className="w-3.5 h-3.5 text-white/30 group-hover:text-white/60 transition-colors flex-shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56 mb-1">
            <DropdownMenuItem onClick={() => router.push("/settings")}>
              <Settings className="w-4 h-4" />
              Configurações
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setTheme(isDark ? "light" : "dark")}>
              {isDark ? (
                <>
                  <Sun className="w-4 h-4" />
                  Tema Claro
                </>
              ) : (
                <>
                  <Moon className="w-4 h-4" />
                  Tema Escuro
                </>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
