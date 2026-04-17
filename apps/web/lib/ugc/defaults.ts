// Default prompt templates for each UGC pipeline stage
export const DEFAULT_PROMPT_TEMPLATES: Record<string, { name: string; content: string }> = {
  creative_analysis: {
    name: "Análise Criativa Padrão",
    content: `Você é um especialista em marketing de performance para TikTok Shop.
Analise os vídeos UGC abaixo sobre o produto "{{product_name}}" e extraia os padrões criativos que estão performando.

VÍDEOS DETECTADOS:
{{videos_data}}

Retorne um JSON com EXATAMENTE esta estrutura:
{
  "productSummary": "resumo do produto em 2 frases",
  "mainBenefits": ["benefício 1", "benefício 2", "benefício 3"],
  "mainPains": ["dor 1", "dor 2"],
  "dominantHooks": ["hook 1", "hook 2", "hook 3"],
  "hookTypes": ["tipo1", "tipo2"],
  "dominantStyles": ["review", "descoberta", "demonstração"],
  "copyPatterns": ["padrão 1", "padrão 2"],
  "successSignals": ["o que está funcionando"],
  "ugcAngles": ["ângulo 1", "ângulo 2", "ângulo 3"],
  "trendSummary": "por que este produto está em alta agora"
}

Retorne APENAS o JSON, sem markdown, sem explicações extras.`,
  },

  creative_brief: {
    name: "Creative Brief Padrão",
    content: `Você é um estrategista criativo sênior de performance UGC pra TikTok Shop.
Monta o brief completo pro vídeo do produto "{{product_name}}".

ANÁLISE DO PRODUTO:
{{analysis_data}}

ÂNGULOS JÁ USADOS RECENTEMENTE (EVITE REPETIR):
{{recent_angles}}

Retorne APENAS um JSON com EXATAMENTE esta estrutura:
{
  "angle": "ângulo criativo único e específico pra este vídeo",
  "tone": "tom emocional dominante (ex: surpresa, alívio, empolgação, curiosidade, indignação)",
  "targetAudience": "público-alvo específico",
  "mainProblem": "dor principal real que o produto resolve",
  "desiredOutcome": "transformação tangível que o viewer vai querer",
  "videoStructure": {
    "take1": "descrição do take 1 — HOOK curioso (0-8s). Pattern interrupt, open loop, stat chocante ou afirmação contraintuitiva.",
    "take2": "descrição do take 2 — payoff parcial + demonstração do benefício (0-8s)",
    "take3": "descrição do take 3 — fechamento + CTA natural (0-8s)"
  },
  "suggestedHooks": ["hook 1 curioso", "hook 2 curioso", "hook 3 curioso"],
  "suggestedCtas": ["cta 1 natural", "cta 2 natural"],
  "visualStyle": "estilo visual (ex: selfie casual, ambiente doméstico, demonstração hands-on)",
  "narrationMode": "creator_speaking | voiceover_narrator"
}

REGRAS CRÍTICAS:
- O ângulo DEVE ser diferente dos ângulos recentes listados.
- O hook DEVE parar o scroll nos primeiros 2s usando UMA destas técnicas: open loop ("ninguém me avisou que..."), pattern interrupt ("para tudo"), revelação contraintuitiva ("achei que era furada até que..."), número chocante, pergunta curiosa. NADA de "Você precisa ver isso" ou "vocês não vão acreditar" genéricos.
- O tom deve parecer um creator real, não publicidade corporativa.
- ESCOLHA UM ÚNICO narrationMode pro vídeo inteiro:
   * "creator_speaking" → a pessoa aparece falando direto na câmera, lip-sync nos 3 takes. A voz é DA pessoa.
   * "voiceover_narrator" → narrador em off nos 3 takes. O creator aparece usando/mostrando o produto mas NÃO fala direto pra câmera. Zero lip-sync.
- NUNCA misture os dois modos no mesmo vídeo.
- Retorne APENAS o JSON.`,
  },

  copy_writer: {
    name: "Roteiro UGC Padrão",
    content: `Você é um copywriter direct response de performance e UGC, top 1% em conversão pra TikTok Shop.
Escreve o roteiro COMPLETO de narração pro vídeo de 15-25 segundos sobre "{{product_name}}".

CREATIVE BRIEF (obedeça tudo daqui, especialmente narrationMode):
{{brief_data}}

HOOKS RECENTES (NÃO REPETIR NEM PARAFRASEAR):
{{recent_hooks}}
CTAs RECENTES (NÃO REPETIR):
{{recent_ctas}}

Retorne APENAS um JSON com EXATAMENTE esta estrutura:
{
  "fullScript": "roteiro único contínuo do vídeo inteiro, texto corrido, ~45-70 palavras, natural e conversacional",
  "takeScripts": {
    "take1": "fala EXATA do take 1 (~2s de silêncio + 6s falando = máx ~18 palavras). HOOK curioso.",
    "take2": "fala EXATA do take 2 (máx ~18 palavras). Reforço + demonstração do benefício.",
    "take3": "fala EXATA do take 3 (máx ~18 palavras). Payoff + CTA fluido."
  },
  "hookUsed": "o hook específico usado no take 1",
  "ctaUsed": "o CTA específico usado no take 3",
  "angleUsed": "o ângulo criativo deste roteiro",
  "styleUsed": "o estilo UGC usado (ex: review, descoberta, reação, problema-solução)"
}

REGRAS CRÍTICAS DE VOZ E NARRAÇÃO:
- O brief traz um campo "narrationMode": respeite.
   * Se "creator_speaking": o roteiro É a pessoa falando em 1a pessoa ("eu comprei", "olha o que aconteceu"). Fluxo coloquial, como quem fala pra amiga.
   * Se "voiceover_narrator": o roteiro É um narrador externo em 3a pessoa ou impessoal ("esse produto tá viralizando porque...", "olha só o que ele faz"). NUNCA use "eu" em primeira pessoa do creator.
- NUNCA misture os dois modos — o vídeo inteiro é um ou o outro.
- Use UMA voz só pro vídeo inteiro. fullScript deve fluir como uma fala contínua — o TTS gera TODO o áudio de uma vez.

REGRAS CRÍTICAS DE COPY (PERSUASÃO FORTE):
- HOOK obrigatório em uma destas técnicas (pique o scroll em 2s):
   1. Open loop: "ninguém me contou que existia isso até..."
   2. Pattern interrupt: "para. eu descobri uma coisa absurda."
   3. Revelação contraintuitiva: "achei que era mais uma furada, mas..."
   4. Número/stat chocante: "gastei X reais e economizei Y..."
   5. Pergunta curiosa e específica: "por que ninguém tá falando sobre isso ainda?"
- PROIBIDO: "vocês precisam ver isso", "não vão acreditar", "melhor compra do mês", "isso mudou minha rotina", qualquer frase que soe como anúncio.
- Take 2 entrega PAYOFF parcial mas segura o clímax — cria tensão pro take 3.
- Take 3 fecha com CTA FLUIDO ("linkei aqui embaixo pra quem quiser", "tá no TikTok Shop, deixei o link") — nunca "compre agora".
- Linguagem: português brasileiro coloquial, frases curtas, sem adjetivos genéricos.
- Cada take precisa ter sentido sozinho E encaixar na sequência.
- NUNCA repita o hook ou o produto 3x seguidas — varie a referência.
- Retorne APENAS o JSON.`,
  },

  veo_prompt: {
    name: "Prompt Veo UGC Padrão",
    content: `Você é especialista em prompts pro modelo de vídeo Veo 3 da Google.
O objetivo é REPLICAR EXATAMENTE a cena de um vídeo UGC de TikTok Shop que já está vendendo, trocando APENAS o avatar da pessoa. Todo o resto (cenário, roupa, objetos, iluminação, enquadramento, ação) deve ser idêntico ao vídeo de referência.

PRODUTO: {{product_name}}
BRIEF CRIATIVO: {{brief_data}}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECEITA VISUAL GERAL DO VÍDEO DE REFERÊNCIA (replique FIELMENTE):
{{reference_scene}}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BREAKDOWN POR TAKE — o que acontece EM CADA TAKE no vídeo de referência (CADA TAKE PODE SER VISUALMENTE DIFERENTE, respeite isso):
{{per_take_scenes}}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PERSONA NOVA (troque SÓ a pessoa — nada mais):
{{persona_description}}

MODO DE NARRAÇÃO: {{narration_mode}}

ROTEIRO POR TAKE:
{{copy_by_take}}

NÚMERO DE TAKES: veja quantos takes existem em copy_by_take e gere EXATAMENTE esse número de prompts.

Retorne APENAS um JSON com EXATAMENTE os takes correspondentes:
Se copy_by_take tem take1,take2,take3,take4 → retorne { "take1": "...", "take2": "...", "take3": "...", "take4": "..." }
Se copy_by_take tem take1,take2,take3 → retorne { "take1": "...", "take2": "...", "take3": "..." }

REGRAS CRÍTICAS (OBEDEÇA LITERALMENTE):
- CADA TAKE deve replicar EXATAMENTE a cena correspondente do breakdown acima. Se o breakdown diz que o take 1 tem MULTIDÃO gritando, o take 1 DEVE mostrar multidão gritando. Se o take 2 tem UMA pessoa falando sozinha, o take 2 DEVE mostrar apenas UMA pessoa. NUNCA misture ou troque o conteúdo dos takes.
- Respeite NÚMERO de pessoas, POSIÇÃO no frame, ENERGIA da cena, ENQUADRAMENTO e COMPOSIÇÃO de cada take individualmente — NÃO invente nada.
- O cenário/ambiente base pode se manter igual, mas AÇÃO, PESSOAS e ENERGIA variam por take conforme o breakdown descreve.
- A persona nova (avatar) aparece nas cenas onde a referência mostra UMA pessoa em close. Em cenas com multidão, TODAS as pessoas devem existir (não apenas a persona).
- Se "hasMultipleVariants" for true no reference_scene, CADA take deve mostrar a variante correta daquele momento (ex: take1=vestido rosa, take2=vestido azul, etc).
- A pessoa central (quando aparece sozinha) DEVE ser IDÊNTICA em TODOS os takes onde aparece — mesmo rosto, mesma cor de pele, mesmo cabelo, mesmo corpo.
- PROIBIDO: corpos cortados, membros deformados, pessoas invadindo objetos (mesa, parede), glitches visuais. Respeite ANATOMIA e composição REAL.

REGRA ABSOLUTA DE NARRAÇÃO (NÃO VIOLAR EM HIPÓTESE ALGUMA):
- Se narration_mode == "voiceover_narrator" E os roteiros dos takes estão VAZIOS (strings vazias ""):
  → CADA prompt DEVE conter EXATAMENTE esta frase: "SILENT — no dialogue, no speech, no lip-sync, no voiceover, no singing, no whispering. The person's mouth stays CLOSED at all times. Ambient sound or background music only."
  → NÃO inclua NENHUMA fala, NENHUM diálogo, NENHUMA narração em NENHUM take.
  → A pessoa NUNCA abre a boca, NUNCA fala, NUNCA narra.
- Se narration_mode == "creator_speaking": inclua a fala literal entre aspas.
- Se narration_mode == "voiceover_narrator" E tem roteiro: "ambient sound only, no dialogue, no lip-sync".

- Formato: vertical 9:16, estética UGC autêntica.
- O produto ({{product_name}}) aparece visivelmente em cada take.
- ZERO texto na tela: NENHUMA legenda, NENHUM subtítulo, NENHUM watermark, NENHUM logo, NENHUM símbolo, NENHUMA letra, NENHUM número, NENHUM emoji. O vídeo deve ser 100% limpo — apenas conteúdo visual puro.
- Cada prompt: 5-7 frases descritivas.
- Retorne APENAS o JSON.`,
  },

  remake: {
    name: "Refação com Feedback Padrão",
    content: `Você é um diretor criativo especialista em UGC para TikTok Shop.
Um vídeo foi rejeitado com o seguinte feedback: "{{feedback}}"

VÍDEO ANTERIOR:
- Produto: {{product_name}}
- Ângulo usado: {{previous_angle}}
- Hook usado: {{previous_hook}}
- Estilo usado: {{previous_style}}
- Roteiro anterior: {{previous_script}}

Com base no feedback, identifique o que precisa mudar e gere instruções específicas.

Retorne um JSON:
{
  "feedbackInterpretation": "o que o usuário quer mudar especificamente",
  "changeType": "hook|tone|structure|product_visibility|cta|style|angle",
  "newAngle": "novo ângulo completamente diferente do anterior",
  "newTone": "novo tom emocional",
  "newHook": "novo hook mais forte",
  "newStructure": "nova estrutura de takes se necessário",
  "instructionsForCopy": "instruções específicas para o novo roteiro",
  "instructionsForVeo": "instruções específicas para os novos prompts Veo",
  "keepWhat": "o que estava bom e deve ser mantido"
}

Retorne APENAS o JSON`,
  },

  caption: {
    name: "Caption TikTok Padrão",
    content: `Gere uma caption persuasiva para TikTok Shop para o produto "{{product_name}}".

ROTEIRO DO VÍDEO:
{{script}}

A caption deve:
- Ter no máximo 150 caracteres
- Incluir 3-5 hashtags relevantes
- Criar curiosidade ou FOMO
- Ter um CTA claro

Retorne apenas a caption com hashtags, sem explicações.`,
  },
};

export const DEFAULT_SCORING_WEIGHTS = {
  viewGrowthWeight: 0.30,
  engagementGrowthWeight: 0.25,
  creatorDiversityWeight: 0.15,
  recurrenceWeight: 0.20,
  accelerationWeight: 0.10,
};

export const UGC_VIDEO_STYLES = [
  "review",
  "descoberta",
  "problema-solução",
  "reação",
  "eu-não-esperava-isso",
  "recomendação-casual",
  "comparativo",
  "demonstração",
] as const;

export type UgcVideoStyle = (typeof UGC_VIDEO_STYLES)[number];

export const TIKTOK_SEARCH_KEYWORDS = [
  "tiktok shop brasil",
  "tiktokshopbrasil",
  "achado tiktok shop",
  "comprei tiktok shop",
  "produto viral tiktok",
  "você precisa ter isso",
  "compra que valeu",
  "testei tiktok shop",
];
