import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { DashboardSidebar } from "@/components/layout/sidebar";
import { DashboardHeader } from "@/components/layout/header";
import { LiveRecordingProvider } from "@/components/providers/live-recording-provider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  return (
    <LiveRecordingProvider>
      <div className="min-h-screen bg-[#030712] mf-page flex">
        <DashboardSidebar user={session.user} />
        <div className="flex-1 flex flex-col min-w-0">
          <DashboardHeader user={session.user} />
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </div>
    </LiveRecordingProvider>
  );
}
