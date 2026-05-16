// Parser puro de tags [A]/[B] na copy de modo conversation.
// Isolado num arquivo próprio (sem dependências server-side) pra ser usado
// tanto no client (preview live na UI) quanto no server (validação + plan).

export type Speaker = "A" | "B";

export interface ConversationTurn {
  speaker: Speaker;
  text: string;
}

const TAG_REGEX = /\[\s*([abAB])\s*\]/g;

export function parseConversationTurns(copy: string): ConversationTurn[] {
  if (!copy?.trim()) return [];

  const matches: Array<{ index: number; length: number; speaker: Speaker }> = [];
  const regex = new RegExp(TAG_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(copy)) !== null) {
    const ch = m[1].toUpperCase() as Speaker;
    matches.push({ index: m.index, length: m[0].length, speaker: ch });
  }

  if (matches.length === 0) {
    const text = copy.trim();
    return text ? [{ speaker: "A", text }] : [];
  }

  const raw: ConversationTurn[] = [];

  const firstIdx = matches[0].index;
  if (firstIdx > 0) {
    const lead = copy.slice(0, firstIdx).trim();
    if (lead) raw.push({ speaker: "A", text: lead });
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextIdx = i + 1 < matches.length ? matches[i + 1].index : copy.length;
    const text = copy.slice(cur.index + cur.length, nextIdx).trim();
    if (text) raw.push({ speaker: cur.speaker, text });
  }

  const merged: ConversationTurn[] = [];
  for (const t of raw) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === t.speaker) {
      last.text = `${last.text} ${t.text}`;
    } else {
      merged.push({ ...t });
    }
  }
  return merged;
}
