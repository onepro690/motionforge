"use client";
import { useEffect, useState } from "react";
import { Settings, Save, Loader2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { TTS_VOICES } from "@/lib/ugc/tts";

interface UgcSettings {
  dailyVideoLimit: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  minTakesPerVideo: number;
  maxTakesPerVideo: number;
  autoMode: boolean;
  requireProductApproval: boolean;
  requireVideoApproval: boolean;
  defaultVoice: string;
  defaultModel: string;
  enableCaptions: boolean;
  tiktokScraperApiKey: string | null;
  searchKeywords: string;
  scoringWeights: {
    viewGrowthWeight: number;
    engagementGrowthWeight: number;
    creatorDiversityWeight: number;
    recurrenceWeight: number;
    accelerationWeight: number;
  };
}

function Toggle({ checked, onChange, label, description }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/[0.04]">
      <div>
        <p className="text-sm text-white">{label}</p>
        {description && <p className="text-xs text-white/40 mt-0.5">{description}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5.5 rounded-full transition-colors ${checked ? "bg-violet-600" : "bg-white/10"}`}
        style={{ height: "22px" }}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

function NumberInput({ label, value, onChange, min, max, description }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; description?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/[0.04]">
      <div>
        <p className="text-sm text-white">{label}</p>
        {description && <p className="text-xs text-white/40 mt-0.5">{description}</p>}
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))}
        min={min}
        max={max}
        className="w-20 bg-white/[0.05] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white text-center focus:outline-none focus:border-violet-500/50"
      />
    </div>
  );
}

function WeightSlider({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-white/60">{label}</span>
        <span className="text-violet-300">{(value * 100).toFixed(0)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(parseInt(e.target.value) / 100)}
        className="w-full accent-violet-500"
      />
    </div>
  );
}

export default function UgcSettingsPage() {
  const [settings, setSettings] = useState<UgcSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    fetch("/api/ugc/settings")
      .then((r) => r.json())
      .then((data: UgcSettings) => setSettings(data))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof UgcSettings>(key: K, value: UgcSettings[K]) => {
    setSettings((prev) => prev ? { ...prev, [key]: value } : prev);
  };

  const setWeight = (key: keyof UgcSettings["scoringWeights"], value: number) => {
    setSettings((prev) => prev ? {
      ...prev,
      scoringWeights: { ...prev.scoringWeights, [key]: value },
    } : prev);
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/ugc/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        toast.success("Configurações salvas!");
      } else {
        const err = await res.json();
        toast.error(err.error ?? "Erro ao salvar");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
      </div>
    );
  }

  const totalWeight = Object.values(settings.scoringWeights).reduce((s, v) => s + v, 0);

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Settings className="w-5 h-5 text-violet-400" />
            Configurações UGC
          </h1>
          <p className="text-sm text-white/40 mt-1">Ajuste o comportamento do sistema de geração automática</p>
        </div>
        <Button onClick={handleSave} disabled={saving} className="bg-violet-600 hover:bg-violet-700 text-white">
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Salvar
        </Button>
      </div>

      {/* Generation limits */}
      <Card className="bg-white/[0.03] border-white/[0.06] p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Limites de Geração</h2>
        <NumberInput label="Vídeos por dia" value={settings.dailyVideoLimit} onChange={(v) => set("dailyVideoLimit", v)} min={1} max={50} description="Máximo de vídeos gerados automaticamente por dia" />
        <NumberInput label="Takes mínimos" value={settings.minTakesPerVideo} onChange={(v) => set("minTakesPerVideo", v)} min={1} max={6} />
        <NumberInput label="Takes máximos" value={settings.maxTakesPerVideo} onChange={(v) => set("maxTakesPerVideo", v)} min={1} max={6} />
        <NumberInput label="Duração mínima (s)" value={settings.minDurationSeconds} onChange={(v) => set("minDurationSeconds", v)} min={5} max={60} />
        <NumberInput label="Duração máxima (s)" value={settings.maxDurationSeconds} onChange={(v) => set("maxDurationSeconds", v)} min={10} max={120} />
      </Card>

      {/* Automation modes */}
      <Card className="bg-white/[0.03] border-white/[0.06] p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Modos de Automação</h2>
        <Toggle
          label="Modo Totalmente Automático"
          description="Gera vídeos sem esperar aprovação de produtos"
          checked={settings.autoMode}
          onChange={(v) => set("autoMode", v)}
        />
        <Toggle
          label="Exigir aprovação de produto"
          description="Produtos precisam ser aprovados antes de gerar vídeos"
          checked={settings.requireProductApproval}
          onChange={(v) => set("requireProductApproval", v)}
        />
        <Toggle
          label="Exigir aprovação de vídeo"
          description="Vídeos precisam de review antes de serem marcados como finais"
          checked={settings.requireVideoApproval}
          onChange={(v) => set("requireVideoApproval", v)}
        />
        <Toggle
          label="Legendas automáticas"
          description="Adicionar legendas nos vídeos gerados"
          checked={settings.enableCaptions}
          onChange={(v) => set("enableCaptions", v)}
        />
      </Card>

      {/* Voice & model */}
      <Card className="bg-white/[0.03] border-white/[0.06] p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Voz e Modelo</h2>

        <div className="py-3 border-b border-white/[0.04] flex items-center justify-between">
          <p className="text-sm text-white">Voz padrão (TTS)</p>
          <select
            value={settings.defaultVoice}
            onChange={(e) => set("defaultVoice", e.target.value)}
            className="bg-white/[0.05] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-violet-500/50"
          >
            {TTS_VOICES.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>

        <div className="py-3 flex items-center justify-between">
          <p className="text-sm text-white">Modelo de vídeo</p>
          <select
            value={settings.defaultModel}
            onChange={(e) => set("defaultModel", e.target.value)}
            className="bg-white/[0.05] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-violet-500/50"
          >
            <option value="veo3-fast">Veo 3 Fast (recomendado)</option>
            <option value="veo3-quality">Veo 3 Quality (mais lento)</option>
          </select>
        </div>
      </Card>

      {/* Scoring weights */}
      <Card className="bg-white/[0.03] border-white/[0.06] p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Pesos do Scoring de Produtos</h2>
          <span className={`text-xs ${Math.abs(totalWeight - 1) > 0.01 ? "text-red-400" : "text-emerald-400"}`}>
            Total: {(totalWeight * 100).toFixed(0)}% {Math.abs(totalWeight - 1) > 0.01 ? "(deve ser 100%)" : "✓"}
          </span>
        </div>
        <div className="space-y-4">
          <WeightSlider label="Crescimento de Views" value={settings.scoringWeights.viewGrowthWeight} onChange={(v) => setWeight("viewGrowthWeight", v)} />
          <WeightSlider label="Crescimento de Engajamento" value={settings.scoringWeights.engagementGrowthWeight} onChange={(v) => setWeight("engagementGrowthWeight", v)} />
          <WeightSlider label="Diversidade de Creators" value={settings.scoringWeights.creatorDiversityWeight} onChange={(v) => setWeight("creatorDiversityWeight", v)} />
          <WeightSlider label="Recorrência (múltiplos vídeos)" value={settings.scoringWeights.recurrenceWeight} onChange={(v) => setWeight("recurrenceWeight", v)} />
          <WeightSlider label="Aceleração Recente" value={settings.scoringWeights.accelerationWeight} onChange={(v) => setWeight("accelerationWeight", v)} />
        </div>
      </Card>

      {/* API Keys */}
      <Card className="bg-white/[0.03] border-white/[0.06] p-5">
        <h2 className="text-sm font-semibold text-white mb-4">API Keys & Configuração</h2>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-white/40 block mb-2">RapidAPI Key (TikTok Scraper)</label>
            <div className="flex gap-2">
              <input
                type={showApiKey ? "text" : "password"}
                value={settings.tiktokScraperApiKey ?? ""}
                onChange={(e) => set("tiktokScraperApiKey", e.target.value || null)}
                placeholder="Deixe vazio para usar dados mockados"
                className="flex-1 bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
              />
              <Button variant="outline" size="sm" className="border-white/10 text-white/60 hover:text-white px-2" onClick={() => setShowApiKey(!showApiKey)}>
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </Button>
            </div>
            <p className="text-xs text-white/30 mt-1">Obtenha em rapidapi.com — suporta "tiktok-scraper7" (default) e "tiktok-api23". Bypass WAF com proxies residenciais; sem chave o scraper acha 0-4 lives porque TikTok bloqueia IPs do Vercel.</p>
          </div>

          <div>
            <label className="text-xs text-white/40 block mb-2">Keywords de Busca (separadas por vírgula)</label>
            <input
              type="text"
              value={settings.searchKeywords}
              onChange={(e) => set("searchKeywords", e.target.value)}
              className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
            />
          </div>
        </div>

        <div className="mt-4 p-3 bg-white/[0.02] rounded-lg text-xs text-white/40 space-y-1">
          <p className="font-medium text-white/60">Outras variáveis de ambiente (no servidor):</p>
          <p>• OPENAI_API_KEY — GPT-4o Mini + TTS (já configurado)</p>
          <p>• GOOGLE_SERVICE_ACCOUNT_JSON — Veo 3 Vertex AI (já configurado)</p>
          <p>• GOOGLE_CLOUD_PROJECT — ID do projeto GCP (já configurado)</p>
          <p>• BLOB_READ_WRITE_TOKEN — Vercel Blob (já configurado)</p>
          <p>• CRON_SECRET — Segredo para scheduler automático</p>
        </div>
      </Card>
    </div>
  );
}
