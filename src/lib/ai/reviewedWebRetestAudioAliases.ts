import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ReviewedWebRetestAudioAlias = {
  id: string;
  source: string;
  canonical: string;
  conversationId: string;
};

export type QuarantinedWebRetestTranscript = {
  source: string;
  reason: string;
};

/**
 * Exact Raw ASR variants observed during the two-device Web retest on
 * 2026-08-11. Only mappings whose meaning remained unambiguous are active.
 */
export const reviewedWebRetestAudioAliasesV1 = Object.freeze<
  ReviewedWebRetestAudioAlias[]
>([
  {
    id: "WEB-RETEST-20260811-001",
    source: "Canh hít màu đỏ",
    canonical: "Con thích màu đỏ.",
    conversationId: "conv_227dcde3",
  },
  {
    id: "WEB-RETEST-20260811-002",
    source: "Chú nói chẳng ngại nhớ",
    canonical: "Chú nói chậm lại nhé",
    conversationId: "conv_de612163",
  },
  {
    id: "WEB-RETEST-20260811-003",
    source: "Chú nói tạm ngài nhé",
    canonical: "Chú nói chậm lại nhé",
    conversationId: "conv_c9f60af8",
  },
]);

export const quarantinedWebRetestTranscriptsV1 = Object.freeze<
  QuarantinedWebRetestTranscript[]
>([
  {
    source: "Cô ngồi anh này bê",
    reason: "Contains a protected speaker role and the intended sentence is uncertain.",
  },
  {
    source: "Mà nó ô nô",
    reason: "The intended sentence cannot be recovered safely from this transcript alone.",
  },
  {
    source: "Con gọi bằng",
    reason: "The ASR result is truncated before the meaning-bearing object.",
  },
  {
    source: "có người bạn bè",
    reason: "This is a plausible standalone sentence with no confirmed target.",
  },
  {
    source: "Cô gọi là Paz",
    reason: "This can be a valid identity statement and contains a protected role/name.",
  },
  {
    source: "Con gọi là Bác",
    reason: "Bác is a valid relationship word and prior labels for this source conflict.",
  },
  {
    source: "Câu câu nhìn",
    reason: "The intended sentence is uncertain.",
  },
  {
    source: "Công cung hình ưu",
    reason: "Mapping it to Con không hiểu would add negation without enough evidence.",
  },
]);

const aliasByExactTranscript = new Map<string, ReviewedWebRetestAudioAlias>();
for (const alias of reviewedWebRetestAudioAliasesV1) {
  const sourceKey = normalizeVietnameseForExactMatch(alias.source);
  const canonicalKey = normalizeVietnameseForExactMatch(alias.canonical);
  if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) {
    throw new Error(`Invalid reviewed Web-retest alias: ${alias.id}`);
  }
  const existing = aliasByExactTranscript.get(sourceKey);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) !== canonicalKey
  ) {
    throw new Error(
      `Conflicting reviewed Web-retest alias: ${existing.id}/${alias.id}`,
    );
  }
  aliasByExactTranscript.set(sourceKey, Object.freeze({ ...alias }));
}

export const reviewedWebRetestAudioAliasStats = Object.freeze({
  observedAt: "2026-08-11",
  activeAliasCount: aliasByExactTranscript.size,
  quarantinedTranscriptCount: quarantinedWebRetestTranscriptsV1.length,
});

export function findReviewedWebRetestAudioAlias(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") return null;
  return (
    aliasByExactTranscript.get(
      normalizeVietnameseForExactMatch(transcript),
    ) ?? null
  );
}
