"use client";
import { useEffect, useState } from "react";
import { FileText, Save, RotateCcw, Loader2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

interface Template {
  id: string;
  stage: string;
  name: string;
  content: string;
  isDefault: boolean;
  version: number;
  updatedAt: string;
}

const STAGE_LABELS: Record<string, string> = {
  creative_analysis: "Análise Criativa",
  creative_brief: "Creative Brief",
  copy_writer: "Roteiro / Copy",
  veo_prompt: "Prompts Veo 3",
  remake: "Refação com Feedback",
  caption: "Caption / Legenda",
};

const STAGE_DESCRIPTIONS: Record<string, string> = {
  creative_analysis: "Analisa vídeos detectados para extrair padrões criativos",
  creative_brief: "Gera o brief criativo com ângulo, tom e estrutura do vídeo",
  copy_writer: "Escreve o roteiro de narração dividido por takes",
  veo_prompt: "Gera prompts detalhados para o Veo 3 Fast por take",
  remake: "Interpreta feedback humano e gera instruções de refação",
  caption: "Gera caption com hashtags para TikTok",
};

const TEMPLATE_VARS: Record<string, string[]> = {
  creative_analysis: ["{{product_name}}", "{{videos_data}}"],
  creative_brief: ["{{product_name}}", "{{analysis_data}}", "{{recent_angles}}"],
  copy_writer: ["{{product_name}}", "{{brief_data}}", "{{recent_hooks}}", "{{recent_ctas}}"],
  veo_prompt: ["{{product_name}}", "{{brief_data}}", "{{copy_by_take}}", "{{visual_style}}"],
  remake: ["{{feedback}}", "{{product_name}}", "{{previous_angle}}", "{{previous_hook}}", "{{previous_style}}", "{{previous_script}}"],
  caption: ["{{product_name}}", "{{script}}"],
};

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Template | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    fetch("/api/ugc/templates")
      .then((r) => r.json())
      .then((data: Template[]) => {
        setTemplates(data);
        if (data.length > 0) {
          setSelected(data[0]);
          setEditContent(data[0].content);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSelect = (t: Template) => {
    setSelected(t);
    setEditContent(t.content);
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/ugc/templates/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      if (res.ok) {
        const updated: Template = await res.json();
        setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        setSelected(updated);
        toast.success("Template salvo!");
      } else {
        toast.error("Erro ao salvar");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!selected) return;
    setResetting(true);
    try {
      const res = await fetch(`/api/ugc/templates/${selected.id}`, { method: "POST" });
      if (res.ok) {
        const updated: Template = await res.json();
        setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        setSelected(updated);
        setEditContent(updated.content);
        toast.success("Template restaurado para o padrão");
      } else {
        toast.error("Erro ao restaurar");
      }
    } finally {
      setResetting(false);
    }
  };

  const hasChanges = selected && editContent !== selected.content;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <FileText className="w-5 h-5 text-violet-400" />
          Prompt Templates
        </h1>
        <p className="text-sm text-white/40 mt-1">
          Edite os prompts internos usados em cada etapa da geração de vídeos
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
        </div>
      ) : (
        <div className="flex gap-6">
          {/* Stage list */}
          <div className="w-52 shrink-0 space-y-1">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => handleSelect(t)}
                className={`w-full text-left px-3 py-3 rounded-lg transition-colors ${
                  selected?.id === t.id
                    ? "bg-violet-500/20 text-white border border-violet-500/30"
                    : "text-white/50 hover:text-white hover:bg-white/[0.05] border border-transparent"
                }`}
              >
                <p className="text-sm font-medium truncate">{STAGE_LABELS[t.stage] ?? t.name}</p>
                <p className="text-xs text-white/30 truncate mt-0.5">v{t.version}</p>
              </button>
            ))}
          </div>

          {/* Editor */}
          {selected && (
            <div className="flex-1 min-w-0 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-white">{STAGE_LABELS[selected.stage] ?? selected.name}</h2>
                  <p className="text-sm text-white/40 mt-0.5">{STAGE_DESCRIPTIONS[selected.stage]}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleReset}
                    disabled={resetting || selected.isDefault}
                    className="border-white/10 text-white/60 hover:text-white"
                  >
                    {resetting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RotateCcw className="w-4 h-4 mr-1" />}
                    Restaurar
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={saving || !hasChanges}
                    className="bg-violet-600 hover:bg-violet-700 text-white"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
                    Salvar
                  </Button>
                </div>
              </div>

              {/* Variables reference */}
              {TEMPLATE_VARS[selected.stage] && (
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3">
                  <p className="text-xs text-white/30 mb-2">Variáveis disponíveis:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {TEMPLATE_VARS[selected.stage].map((v) => (
                      <code key={v} className="px-2 py-0.5 bg-violet-500/10 text-violet-300 text-xs rounded font-mono">
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
              )}

              {/* Editor textarea */}
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full h-[500px] bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 text-sm text-white/80 font-mono leading-relaxed resize-none focus:outline-none focus:border-violet-500/50 placeholder-white/20"
                spellCheck={false}
              />

              {hasChanges && (
                <p className="text-xs text-yellow-400">Você tem alterações não salvas</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
