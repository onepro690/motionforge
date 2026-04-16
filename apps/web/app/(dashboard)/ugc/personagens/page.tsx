"use client";
import { useEffect, useState, useCallback } from "react";
import { upload } from "@vercel/blob/client";
import {
  UserCircle, Plus, Trash2, Loader2, ImagePlus, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

interface Character {
  id: string;
  name: string;
  imageUrl: string;
  createdAt: string;
}

export default function PersonagensPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ugc/characters");
      if (res.ok) {
        const data = await res.json();
        setCharacters(data.characters);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Selecione uma imagem");
      return;
    }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleCreate = async () => {
    if (!name.trim()) { toast.error("Digite um nome para o personagem"); return; }
    if (!imageFile) { toast.error("Selecione uma foto do avatar"); return; }

    setCreating(true);
    try {
      // Upload da imagem pro Vercel Blob
      setUploading(true);
      const blob = await upload(`ugc-character-${Date.now()}.${imageFile.name.split(".").pop()}`, imageFile, {
        access: "public",
        handleUploadUrl: "/api/upload",
      });
      setUploading(false);

      // Cria o personagem
      const res = await fetch("/api/ugc/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), imageUrl: blob.url }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Erro" }));
        toast.error(err.error ?? "Erro ao criar personagem");
        return;
      }

      toast.success("Personagem criado!");
      setName("");
      setImageFile(null);
      setImagePreview(null);
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setDeleting(id);
    try {
      const res = await fetch(`/api/ugc/characters?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Personagem removido");
        load();
      } else {
        toast.error("Erro ao remover");
      }
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <UserCircle className="w-5 h-5 text-violet-400" />
            Personagens
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Seus avatares para gerar vídeos UGC. O personagem substitui a pessoa do vídeo de referência.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowForm(!showForm)}
          className="bg-violet-600 hover:bg-violet-500 text-white"
        >
          {showForm ? <X className="w-4 h-4 mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
          {showForm ? "Cancelar" : "Novo Personagem"}
        </Button>
      </div>

      {/* Create form */}
      {showForm && (
        <Card className="bg-white/[0.03] border-white/[0.08] p-5 space-y-4">
          <div className="space-y-2">
            <label className="text-sm text-white/60">Nome do personagem</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Ana, João, Modelo 1..."
              className="w-full bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-violet-500/50"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm text-white/60">Foto do avatar</label>
            <p className="text-xs text-white/30">Use uma foto clara do rosto — será usada em todos os vídeos deste personagem.</p>
            <div className="flex items-start gap-4">
              {imagePreview ? (
                <div className="relative">
                  <img src={imagePreview} alt="Preview" className="w-24 h-24 rounded-lg object-cover border border-white/10" />
                  <button
                    onClick={() => { setImageFile(null); setImagePreview(null); }}
                    className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center"
                  >
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
              ) : (
                <label className="w-24 h-24 rounded-lg border-2 border-dashed border-white/10 hover:border-violet-500/30 flex flex-col items-center justify-center cursor-pointer transition-colors">
                  <ImagePlus className="w-6 h-6 text-white/30" />
                  <span className="text-[10px] text-white/30 mt-1">Escolher</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
            </div>
          </div>

          <Button
            onClick={handleCreate}
            disabled={creating || !name.trim() || !imageFile}
            className="bg-violet-600 hover:bg-violet-500 text-white"
          >
            {creating ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-1.5" />{uploading ? "Enviando foto..." : "Criando..."}</>
            ) : (
              <><Plus className="w-4 h-4 mr-1.5" />Criar Personagem</>
            )}
          </Button>
        </Card>
      )}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
        </div>
      ) : characters.length === 0 ? (
        <Card className="bg-white/[0.02] border-white/[0.06] p-12 text-center">
          <UserCircle className="w-10 h-10 text-white/20 mx-auto mb-3" />
          <p className="text-white/40 text-sm">Nenhum personagem criado</p>
          <p className="text-white/20 text-xs mt-1">Crie um personagem para usar como avatar nos vídeos UGC</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {characters.map((char) => (
            <Card key={char.id} className="bg-white/[0.03] border-white/[0.06] overflow-hidden group">
              <div className="aspect-[3/4] relative">
                <img src={char.imageUrl} alt={char.name} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-3">
                  <p className="text-sm font-semibold text-white">{char.name}</p>
                  <p className="text-[10px] text-white/40 mt-0.5">
                    {new Date(char.createdAt).toLocaleDateString("pt-BR")}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(char.id)}
                  disabled={deleting === char.id}
                  className={`absolute top-2 right-2 p-1.5 rounded-lg transition-all ${
                    confirmDelete === char.id
                      ? "bg-red-500/80 text-white"
                      : "bg-black/40 text-white/50 opacity-0 group-hover:opacity-100 hover:text-red-400"
                  }`}
                >
                  {deleting === char.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
