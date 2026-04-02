"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CancelButton({ jobId }: { jobId: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleCancel() {
    if (!confirm("Cancelar a geração? Os créditos não serão cobrados se o job ainda estiver na fila.")) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json();
        alert(data.error ?? "Erro ao cancelar");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      onClick={handleCancel}
      disabled={loading}
      size="sm"
      variant="outline"
      className="gap-2 border-red-500/30 text-red-300 hover:bg-red-500/10 hover:border-red-500/50"
    >
      <XCircle className="w-3 h-3" />
      {loading ? "Cancelando..." : "Cancelar"}
    </Button>
  );
}
