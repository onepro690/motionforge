"use client";
import { useState, useRef } from "react";
import Link from "next/link";
import {
  ArrowLeft, Radio, Send, Plus, Trash2,
  Monitor, ExternalLink, Copy, Check,
} from "lucide-react";

const CHANNEL = "motionforge-live";

const FACES = [
  { id: "5514e24d-6086-46a3-ace4-6a7264e5cb7c", name: "Anna" },
  { id: "cace3ef7-a4c4-425d-a8cf-a5358eb0c427", name: "Tina" },
  { id: "b9e5fba3-071a-4e35-896e-211c4d6eaa7b", name: "Laila" },
  { id: "d2a5c7c6-fed9-4f55-bcb3-062f7cd20103", name: "Kate" },
  { id: "5fc23ea5-8175-4a82-aaaf-cdd8c88543dc", name: "Madison" },
  { id: "b1f6ad8f-ed78-430b-85ef-2ec672728104", name: "Charlotte" },
  { id: "804c347a-26c9-4dcf-bb49-13df4bed61e8", name: "Mark" },
  { id: "1c6aa65c-d858-4721-a4d9-bda9fde03141", name: "Fred" },
  { id: "f1abe833-b44c-4650-a01c-191b9c3c43b8", name: "Tony" },
  { id: "7e74d6e7-d559-4394-bd56-4923a3ab75ad", name: "Sabour" },
  { id: "afdb6a3e-3939-40aa-92df-01604c23101c", name: "Zahra" },
  { id: "dd10cb5a-d31d-4f12-b69f-6db3383c006e", name: "Hank" },
  { id: "f0ba4efe-7946-45de-9955-c04a04c367b9", name: "Doctor" },
  { id: "9d0ba12e-ebad-4bfa-b1fb-c6c5be21abca", name: "Teenager" },
  { id: "c65af549-9105-442a-92a3-dc6c89e34149", name: "DJ" },
  { id: "c295e3a2-ed11-48d5-a1bd-ff42ac7eac73", name: "Einstein" },
  { id: "4cce0ca0-550f-42d8-b500-834ffb35e0af", name: "Catgirl" },
  { id: "c7451e55-ea04-41c8-ab47-bdca3e4a03d8", name: "Cleopatra" },
];

export default function LiveControlPage() {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [liveViewOpen, setLiveViewOpen] = useState(false);
  const [faceId, setFaceId] = useState(FACES[0].id);
  const [script, setScript] = useState("");
  const [queue, setQueue] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const liveViewUrl = typeof window !== "undefined"
    ? `${window.location.origin}/live-view`
    : "/live-view";

  const getChannel = () => {
    if (!channelRef.current) channelRef.current = new BroadcastChannel(CHANNEL);
    return channelRef.current;
  };

  const openLiveView = () => {
    window.open("/live-view", "live-view", "width=1280,height=720");
    setLiveViewOpen(true);
    // Envia init após um momento para a janela carregar
    setTimeout(() => {
      getChannel().postMessage({ type: "init", payload: { faceId } });
    }, 3000);
  };

  const sendSpeak = (text: string) => {
    if (!text.trim()) return;
    getChannel().postMessage({ type: "speak", payload: { text: text.trim() } });
  };

  const handleSpeakNow = () => {
    sendSpeak(script);
    setScript("");
  };

  const addToQueue = () => {
    if (!script.trim()) return;
    setQueue((q) => [...q, script.trim()]);
    setScript("");
  };

  const speakNext = () => {
    if (queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    sendSpeak(next);
  };

  const stopLive = () => {
    getChannel().postMessage({ type: "stop" });
    setLiveViewOpen(false);
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(liveViewUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-white/[0.06] flex-shrink-0">
        <Link href="/hub" className="flex items-center gap-1.5 text-white/40 hover:text-white text-sm transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Voltar
        </Link>
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-pink-400" />
          <span className="font-semibold text-white text-sm">TikTok Live Studio</span>
        </div>
        {liveViewOpen && (
          <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
            Live View aberta
          </span>
        )}
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_380px] min-h-0">

        {/* Painel esquerdo — TikTok LIVE Studio setup */}
        <div className="flex flex-col gap-6 p-6 border-r border-white/[0.06]">

          {/* Browser Source */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Monitor className="w-4 h-4 text-pink-400" />
              <h2 className="font-semibold text-white text-sm">TikTok LIVE Studio — Browser Source</h2>
            </div>
            <ol className="space-y-2 text-sm text-white/50">
              <li className="flex gap-2"><span className="text-pink-400 font-bold">1.</span> Clique em <strong className="text-white/70">Abrir Live View</strong> abaixo</li>
              <li className="flex gap-2"><span className="text-pink-400 font-bold">2.</span> No TikTok LIVE Studio: <strong className="text-white/70">+ Adicionar fonte → Browser Source</strong></li>
              <li className="flex gap-2"><span className="text-pink-400 font-bold">3.</span> Cole a URL da Live View</li>
              <li className="flex gap-2"><span className="text-pink-400 font-bold">4.</span> Configure 1280×720 e marque <strong className="text-white/70">Áudio do browser</strong></li>
              <li className="flex gap-2"><span className="text-pink-400 font-bold">5.</span> Use o painel à direita para o avatar falar</li>
            </ol>

            {/* URL da live view */}
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <code className="flex-1 text-xs text-white/60 truncate">{liveViewUrl}</code>
              <button onClick={copyUrl} className="text-white/40 hover:text-white transition-colors flex-shrink-0">
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <button
              onClick={liveViewOpen ? stopLive : openLiveView}
              className={`w-full flex items-center justify-center gap-2 rounded-lg py-3 text-sm font-medium transition-colors ${
                liveViewOpen
                  ? "bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400"
                  : "bg-pink-500 hover:bg-pink-400 text-white"
              }`}
            >
              {liveViewOpen ? (
                "Fechar Live View"
              ) : (
                <><ExternalLink className="w-4 h-4" />Abrir Live View</>
              )}
            </button>
          </div>

          {/* Avatar selector */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 space-y-3">
            <h2 className="font-semibold text-white text-sm">Avatar</h2>
            <div className="grid grid-cols-3 gap-2">
              {FACES.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFaceId(f.id)}
                  className={`py-2 px-3 rounded-lg text-xs font-medium transition-all border ${
                    faceId === f.id
                      ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                      : "bg-white/[0.03] border-white/[0.08] text-white/50 hover:text-white hover:border-white/20"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-white/30">
              Troque o avatar antes de abrir a Live View.
            </p>
          </div>
        </div>

        {/* Painel direito — Script */}
        <div className="flex flex-col overflow-hidden">
          <div className="flex-1 flex flex-col p-5 gap-3 overflow-hidden min-h-0">
            <p className="text-[11px] text-white/40 uppercase tracking-wider font-medium flex-shrink-0">
              Script do Avatar
            </p>

            <div className="space-y-2 flex-shrink-0">
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addToQueue(); } }}
                placeholder="Digite o que o avatar vai falar..."
                rows={5}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-pink-500/50 resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSpeakNow}
                  disabled={!script.trim() || !liveViewOpen}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-pink-500 hover:bg-pink-400 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg py-2 text-sm font-medium transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                  {liveViewOpen ? "Falar agora" : "Abra a Live View primeiro"}
                </button>
                <button
                  onClick={addToQueue}
                  disabled={!script.trim()}
                  title="Adicionar à fila"
                  className="flex items-center justify-center bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed border border-white/10 text-white/70 rounded-lg px-3 py-2 text-sm transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Fila */}
            {queue.length > 0 && (
              <div className="flex-1 flex flex-col gap-2 overflow-hidden min-h-0">
                <div className="flex items-center justify-between flex-shrink-0">
                  <p className="text-xs text-white/40">Fila ({queue.length})</p>
                  <button
                    onClick={speakNext}
                    disabled={!liveViewOpen}
                    className="text-xs text-pink-400 hover:text-pink-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Falar próximo →
                  </button>
                </div>
                <div className="flex-1 overflow-auto space-y-2">
                  {queue.map((item, i) => (
                    <div key={i} className="flex items-start gap-2 bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                      <span className="text-xs text-white/30 mt-0.5 w-4 flex-shrink-0">{i + 1}</span>
                      <p className="flex-1 text-xs text-white/70 leading-relaxed line-clamp-2">{item}</p>
                      <button onClick={() => setQueue((q) => q.filter((_, j) => j !== i))} className="text-white/20 hover:text-red-400 transition-colors flex-shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
