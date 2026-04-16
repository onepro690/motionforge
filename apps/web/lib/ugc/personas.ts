// Persona randomizer pros vídeos UGC.
//
// A cada geração sorteamos um creator NOVO — diferente do vídeo de referência
// e diferente de gerações anteriores do mesmo produto. A persona vira parte
// do Veo prompt, garantindo consistência DENTRO do vídeo (mesma pessoa nos 3
// takes) e variedade ENTRE vídeos.

export interface UgcPersona {
  gender: "feminino" | "masculino";
  ageRange: string;
  ethnicity: string;
  hair: string;
  outfit: string;
  environment: string;
  lighting: string;
  vibe: string;
  voiceDescriptor: string;
}

const GENDERS: UgcPersona["gender"][] = ["feminino", "masculino"];

const AGES = [
  "jovem adulto de 20-25 anos",
  "adulto de 26-32 anos",
  "adulto de 33-40 anos",
];

const ETHNICITIES = [
  "brasileira parda de pele média",
  "brasileira branca de pele clara",
  "brasileira negra de pele escura",
  "brasileira morena de pele bronzeada",
  "brasileira de traços latinos",
  "brasileira de traços asiáticos",
];

const HAIR = [
  "cabelo liso castanho escuro na altura dos ombros",
  "cabelo cacheado preto volumoso",
  "cabelo loiro ondulado preso num rabo solto",
  "cabelo curto castanho claro estilo pixie",
  "cabelo longo ruivo natural",
  "cabelo crespo preto estilo black power",
  "cabelo liso castanho médio abaixo do ombro",
  "cabelo ondulado mel com mechas naturais",
];

const OUTFITS = [
  "blusa básica branca e calça jeans",
  "camiseta oversized bege e shorts",
  "moletom cinza confortável",
  "regata preta simples",
  "blusinha de alcinha rosa claro",
  "camiseta estampada casual",
  "conjunto de malha neutro",
];

const ENVIRONMENTS = [
  "quarto bem iluminado com cama desarrumada ao fundo desfocada",
  "sala de estar aconchegante com sofá bege desfocado",
  "cozinha moderna com bancada branca ao fundo",
  "banheiro claro com azulejo branco desfocado",
  "escrivaninha com livros e plantinhas desfocadas ao fundo",
  "parede lisa clara de apartamento com quadro pequeno",
  "closet com roupas penduradas desfocadas atrás",
];

const LIGHTING = [
  "luz natural suave vindo de janela lateral",
  "ring light frontal dando brilho no rosto",
  "golden hour entrando pela janela",
  "luz quente de abajur com preenchimento neutro",
  "luz natural difusa de dia nublado pela janela",
];

const VIBES = [
  "animada e empolgada, gesticulando com as mãos",
  "calma e convincente, olhar direto na câmera",
  "surpresa e entusiasmada, como quem acabou de descobrir algo",
  "confiante e casual, tom de amiga contando novidade",
  "curiosa e envolvente, como quem compartilha um segredo",
];

const VOICE_DESCRIPTORS_F = [
  "voz feminina jovem, tom quente e amigável",
  "voz feminina suave e próxima, como amiga",
  "voz feminina animada e expressiva",
];

const VOICE_DESCRIPTORS_M = [
  "voz masculina jovem, tom descontraído",
  "voz masculina calma e confiante",
  "voz masculina expressiva e próxima",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pickRandomPersona(): UgcPersona {
  const gender = pick(GENDERS);
  return {
    gender,
    ageRange: pick(AGES),
    ethnicity: pick(ETHNICITIES),
    hair: pick(HAIR),
    outfit: pick(OUTFITS),
    environment: pick(ENVIRONMENTS),
    lighting: pick(LIGHTING),
    vibe: pick(VIBES),
    voiceDescriptor: gender === "feminino" ? pick(VOICE_DESCRIPTORS_F) : pick(VOICE_DESCRIPTORS_M),
  };
}

export function personaToDescription(p: UgcPersona): string {
  return [
    `pessoa ${p.gender === "feminino" ? "do sexo feminino" : "do sexo masculino"}`,
    p.ageRange,
    p.ethnicity,
    `com ${p.hair}`,
    `vestindo ${p.outfit}`,
    `em ${p.environment}`,
    `iluminação: ${p.lighting}`,
    `personalidade no take: ${p.vibe}`,
  ].join(", ");
}
