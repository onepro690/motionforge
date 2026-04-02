import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { SettingsForm } from "@/components/settings/settings-form";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Configurações</h1>
        <p className="text-white/50 mt-1">
          Gerencie seu perfil e preferências
        </p>
      </div>

      <SettingsForm user={session!.user} />
    </div>
  );
}
