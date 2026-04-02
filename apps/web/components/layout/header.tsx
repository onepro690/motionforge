"use client";
import { signOut } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { LogOut, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface HeaderProps {
  user: { name?: string | null; email: string };
}

export function DashboardHeader({ user: _user }: HeaderProps) {
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut();
    toast.success("Até logo!");
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="h-16 border-b border-white/[0.06] flex items-center justify-between px-6">
      <div />
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="text-white/50 hover:text-white w-9 h-9"
        >
          <Bell className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          className="text-white/50 hover:text-white gap-2"
        >
          <LogOut className="w-4 h-4" />
          Sair
        </Button>
      </div>
    </header>
  );
}
