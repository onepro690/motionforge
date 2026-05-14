// Builder de arquivo ASS estilo "karaoke linha":
// uma linha embaixo no centro, palavra atual preenchendo de amarelo conforme
// a fala progride (\kf — karaoke fill).
//
// Notas técnicas críticas:
//  - PrimaryColour = cor DEPOIS que a palavra foi cantada (amarelo)
//  - SecondaryColour = cor ANTES (branco)
//  - \kf<centiseconds> faz o preenchimento gradual durante X cs
//  - PlayResX/PlayResY do ASS DEVEM bater com a resolução real do vídeo,
//    senão libass escala a fonte e fica gigante/minúscula.

import type { CaptionLine } from "./transcribe";

interface BuildAssOpts {
  videoWidth: number;
  videoHeight: number;
  // Posição vertical do CENTRO da legenda, em % da altura do vídeo (0=topo, 100=base).
  // Default 88 = "embaixo" (legenda fica perto do rodapé, com folga pra safe zone).
  position?: number;
}

// ASS time: H:MM:SS.cs
function fmtTime(t: number): string {
  if (t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

function escapeAssText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

// Calcula fontsize proporcional à altura do vídeo. Tunado pra ficar legível
// em qualquer aspect (9:16, 16:9, 1:1) sem nunca passar de ~1/3 da tela.
function pickFontSize(videoHeight: number): number {
  const base = Math.round(videoHeight / 22);
  return Math.max(38, Math.min(110, base));
}

function pickOutline(fontSize: number): number {
  return Math.max(3, Math.round(fontSize * 0.08));
}

function pickShadow(fontSize: number): number {
  return Math.max(1, Math.round(fontSize * 0.03));
}

export function buildKaraokeAss(lines: CaptionLine[], opts: BuildAssOpts): string {
  const { videoWidth, videoHeight } = opts;
  const fontSize = pickFontSize(videoHeight);
  const outline = pickOutline(fontSize);
  const shadow = pickShadow(fontSize);

  // Posição vertical do centro da legenda (em px do topo). Clampa pra não
  // encostar nas bordas — mantém uma margem mínima de half-fontsize.
  const positionPct = Math.max(0, Math.min(100, opts.position ?? 88));
  const minY = Math.round(fontSize * 0.7);
  const maxY = videoHeight - Math.round(fontSize * 0.7);
  const centerY = Math.max(minY, Math.min(maxY, Math.round((positionPct / 100) * videoHeight)));
  const centerX = Math.round(videoWidth / 2);

  const out: string[] = [];
  out.push("[Script Info]");
  out.push("Title: MotionForge karaoke captions");
  out.push("ScriptType: v4.00+");
  out.push("WrapStyle: 2"); // quebra automática quebrando em qualquer ponto se a linha exceder
  out.push("ScaledBorderAndShadow: yes");
  out.push(`PlayResX: ${videoWidth}`);
  out.push(`PlayResY: ${videoHeight}`);
  out.push("YCbCr Matrix: TV.709");
  out.push("");

  out.push("[V4+ Styles]");
  out.push(
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  );
  // Cores ASS: &HAABBGGRR (alpha + BGR invertido)
  // PrimaryColour (depois de preencher): amarelo dourado vivo (BGR 00F0FF → #FFF000)
  // SecondaryColour (antes):             branco
  // OutlineColour:                       preto
  // BackColour (sombra):                 preto semi-transparente
  // Alignment 5 = middle center — combinamos com \pos por linha pra controle exato.
  // Bold 1, BorderStyle 1 (outline+shadow)
  const styleLine =
    `Style: Karaoke,Anton,${fontSize},` +
    `&H0000F0FF,` +
    `&H00FFFFFF,` +
    `&H00000000,` +
    `&H80000000,` +
    `1,0,0,0,100,100,0,0,1,${outline},${shadow},5,80,80,0,1`;
  out.push(styleLine);
  out.push("");

  out.push("[Events]");
  out.push(
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  );

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.words.length === 0) continue;

    const next = lines[li + 1];
    // Estende ligeiramente até o início da próxima linha (sem gap visível)
    const visualEnd = next ? Math.min(next.start, line.end + 0.12) : line.end + 0.25;
    const start = fmtTime(line.start);
    const end = fmtTime(visualEnd);

    // Monta o texto com tags \kf por palavra.
    // O \kf de cada palavra cobre do start dela até o start da próxima palavra
    // (ou até o end da última). Assim gaps de silêncio não "engolem" o highlight.
    const parts: string[] = [];
    for (let i = 0; i < line.words.length; i++) {
      const w = line.words[i];
      const nextW = line.words[i + 1];
      const wordSpanSec = nextW
        ? Math.max(0.05, nextW.start - w.start)
        : Math.max(0.05, w.end - w.start);
      const kfCs = Math.max(1, Math.round(wordSpanSec * 100));
      const txt = escapeAssText(w.word.trim().toUpperCase());
      parts.push(`{\\kf${kfCs}}${txt}`);
    }
    // Junta com espaços simples — o \kf antes de cada palavra delimita o highlight.
    // \an5\pos sobrepõe alignment e posiciona o centro da linha em (centerX, centerY).
    // Pop sutil de scale no começo da linha pra dar "vida" sem virar pop-word.
    const intro = `{\\an5\\pos(${centerX},${centerY})\\fad(80,80)\\t(0,140,\\fscx108\\fscy108)\\t(140,260,\\fscx100\\fscy100)}`;
    const text = intro + parts.join(" ");
    out.push(`Dialogue: 0,${start},${end},Karaoke,,0,0,0,,${text}`);
  }

  return out.join("\n");
}
