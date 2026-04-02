"use client";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Loader2, User, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const profileSchema = z.object({
  name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres"),
});

const passwordSchema = z
  .object({
    currentPassword: z.string().min(8),
    newPassword: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "As senhas não coincidem",
    path: ["confirmPassword"],
  });

interface SettingsFormProps {
  user: { name?: string | null; email: string; id: string };
}

export function SettingsForm({ user }: SettingsFormProps) {
  const [profileLoading, setProfileLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const profileForm = useForm({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: user.name ?? "" },
  });

  const passwordForm = useForm({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  const onProfileSubmit = async (data: { name: string }) => {
    setProfileLoading(true);
    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Erro ao atualizar perfil");
      toast.success("Perfil atualizado!");
    } catch {
      toast.error("Erro ao atualizar perfil");
    } finally {
      setProfileLoading(false);
    }
  };

  const onPasswordSubmit = async (
    data: z.infer<typeof passwordSchema>
  ) => {
    setPasswordLoading(true);
    try {
      const res = await fetch("/api/user/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: data.currentPassword,
          newPassword: data.newPassword,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Erro ao atualizar senha");
      }
      toast.success("Senha atualizada!");
      passwordForm.reset();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Erro ao atualizar senha"
      );
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Profile */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
              <User className="w-5 h-5 text-violet-400" />
            </div>
            <div>
              <CardTitle className="text-white text-base">Perfil</CardTitle>
              <CardDescription className="text-white/40 text-sm">
                Atualize suas informações pessoais
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={profileForm.handleSubmit(onProfileSubmit)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label className="text-white/70">Email</Label>
              <Input
                value={user.email}
                disabled
                className="bg-white/5 border-white/10 text-white/40"
              />
              <p className="text-xs text-white/30">
                Email não pode ser alterado
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-white/70">Nome</Label>
              <Input
                className="bg-white/5 border-white/10 text-white focus:border-violet-500"
                {...profileForm.register("name")}
              />
              {profileForm.formState.errors.name && (
                <p className="text-red-400 text-sm">
                  {profileForm.formState.errors.name.message}
                </p>
              )}
            </div>
            <Button
              type="submit"
              disabled={profileLoading}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {profileLoading && (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              )}
              Salvar alterações
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Password */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
              <Lock className="w-5 h-5 text-violet-400" />
            </div>
            <div>
              <CardTitle className="text-white text-base">Segurança</CardTitle>
              <CardDescription className="text-white/40 text-sm">
                Altere sua senha de acesso
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={passwordForm.handleSubmit(onPasswordSubmit)}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label className="text-white/70">Senha atual</Label>
              <Input
                type="password"
                className="bg-white/5 border-white/10 text-white focus:border-violet-500"
                {...passwordForm.register("currentPassword")}
              />
            </div>
            <Separator className="bg-white/[0.06]" />
            <div className="space-y-2">
              <Label className="text-white/70">Nova senha</Label>
              <Input
                type="password"
                className="bg-white/5 border-white/10 text-white focus:border-violet-500"
                {...passwordForm.register("newPassword")}
              />
              {passwordForm.formState.errors.newPassword && (
                <p className="text-red-400 text-sm">
                  {passwordForm.formState.errors.newPassword.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-white/70">Confirmar nova senha</Label>
              <Input
                type="password"
                className="bg-white/5 border-white/10 text-white focus:border-violet-500"
                {...passwordForm.register("confirmPassword")}
              />
              {passwordForm.formState.errors.confirmPassword && (
                <p className="text-red-400 text-sm">
                  {passwordForm.formState.errors.confirmPassword.message}
                </p>
              )}
            </div>
            <Button
              type="submit"
              disabled={passwordLoading}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {passwordLoading && (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              )}
              Atualizar senha
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
