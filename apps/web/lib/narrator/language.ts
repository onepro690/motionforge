// Detecção simples de idioma da copy via contagem de stopwords. Cobre os
// 3 idiomas mais comuns do projeto (pt-BR, en, es). Heurística, não LLM —
// suficiente pra escolher os locks do Veo. Default cai pra pt-BR.

export type NarratorLanguage = "pt-BR" | "en" | "es";

const PT_STOPWORDS = [
  "você","voce","seu","sua","com","que","para","como","está","esta","estão","estao",
  "uma","isso","aqui","ali","não","nao","também","tambem","muito","mais","menos",
  "quando","porque","então","entao","tudo","todos","mesma","mesmo","sobre",
  "podemos","vamos","fazer","ainda","cada","melhor","pior","quero","preciso",
  "tem","têm","tenho","será","sera","fica","ficar","quase","sempre","nunca",
  "alguém","alguem","ninguém","ninguem","dentro","fora","perto","longe","pelo",
  "pela","pelos","pelas","aos","das","dos","ele","ela","eles","elas","vai",
  "vou","vem","vemos","amor","alma","destino","caminho","mensagem","sinal",
];

const EN_STOPWORDS = [
  "the","you","your","are","this","that","and","with","what","have","they","from",
  "will","would","could","should","their","there","about","which","when","where",
  "while","than","then","them","these","those","into","over","under","just","only",
  "every","never","always","because","really","gonna","wanna","cause","were","been",
  "being","does","doesn","didn","don","i'm","you're","they're","we're","i've",
  "you've","let's","here","love","soul","fate","sign","path","destiny","message",
];

const ES_STOPWORDS = [
  "tú","tu","usted","con","que","para","cómo","como","está","están","una","esto",
  "eso","aquí","allí","no","también","mucho","más","menos","cuando","porque",
  "entonces","todo","todos","misma","mismo","sobre","podemos","vamos","hacer",
  "todavía","cada","mejor","peor","quiero","necesito","tiene","tienen","tengo",
  "será","queda","quedar","casi","siempre","nunca","alguien","nadie","dentro",
  "fuera","cerca","lejos","por","las","los","él","ella","ellos","ellas","amor",
  "alma","destino","camino","mensaje","señal","senal",
];

function score(lower: string, words: string[]): number {
  let total = 0;
  for (const w of words) {
    // \b com unicode flag pra suportar acentos
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = lower.match(new RegExp(`\\b${escaped}\\b`, "gu"));
    if (m) total += m.length;
  }
  return total;
}

export function detectLanguage(copy: string): NarratorLanguage {
  const lower = copy.toLowerCase();
  const pt = score(lower, PT_STOPWORDS);
  const en = score(lower, EN_STOPWORDS);
  const es = score(lower, ES_STOPWORDS);

  // Empate ou nada detectado → cai pra pt-BR (base de usuários do projeto)
  if (pt === 0 && en === 0 && es === 0) return "pt-BR";
  if (pt >= en && pt >= es) return "pt-BR";
  if (en >= pt && en >= es) return "en";
  return "es";
}

// Nome humano usado dentro do prompt do Veo ("Brazilian Portuguese", "English",
// "Spanish"). Veo aceita esses labels diretamente.
export function languageLabel(lang: NarratorLanguage): string {
  switch (lang) {
    case "pt-BR": return "Brazilian Portuguese";
    case "en":    return "English";
    case "es":    return "Spanish";
  }
}

// Lista de idiomas a EXCLUIR no negative do prompt. Tudo que NÃO é o idioma da
// copy vira proibido pra Veo não improvisar em outro.
export function forbiddenLanguagesClause(lang: NarratorLanguage): string {
  const all = ["Brazilian Portuguese", "English", "Mandarin", "Cantonese", "Japanese", "Korean", "Spanish", "European Portuguese"];
  const allow = languageLabel(lang);
  const forbid = all.filter((l) => l !== allow);
  return `Do NOT speak in ${forbid.join(", ")} or any other language than ${allow}.`;
}
