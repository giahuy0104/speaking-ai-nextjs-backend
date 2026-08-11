import { repairVietnameseChildTranscript } from "./transcriptRepair";
import { repairVietnameseTranscriptWithCorpus } from "./transcriptCorpusRepair";
import { normalizeRegionalVietnameseOutsideCorpus } from "./regionalVocabularyNormalizer";

export type ChildSpeechTranscriptDiagnostic = {
  rawText: string;
  text: string;
  subjectRepairApplied: boolean;
  corpusRepairApplied: boolean;
  corpusRuleId?: string;
  correctionId?: string;
  strategy?: string;
  score?: number;
  margin?: number;
  regionalVocabularyApplied: boolean;
  regionalVocabularyReplacementCount: number;
  regionalVocabularySourceRows: number[];
  unresolvedRegionalVariantCount: number;
  repairMs: number;
};

export function diagnoseChildSpeechTranscript(
  text: string,
): ChildSpeechTranscriptDiagnostic {
  const repairStartedAt = performance.now();
  const subjectRepaired = repairVietnameseChildTranscript(text);
  const corpusRepair = repairVietnameseTranscriptWithCorpus(subjectRepaired);
  const regionalNormalization = corpusRepair.ruleId || corpusRepair.repaired
    ? null
    : normalizeRegionalVietnameseOutsideCorpus(corpusRepair.text);

  return {
    rawText: text,
    text: regionalNormalization?.text ?? corpusRepair.text,
    subjectRepairApplied: subjectRepaired !== text,
    corpusRepairApplied: corpusRepair.repaired,
    corpusRuleId: corpusRepair.ruleId,
    correctionId: corpusRepair.correctionId,
    strategy: corpusRepair.strategy,
    score: corpusRepair.score,
    margin: corpusRepair.margin,
    regionalVocabularyApplied: regionalNormalization?.normalized === true,
    regionalVocabularyReplacementCount:
      regionalNormalization?.replacements.length ?? 0,
    regionalVocabularySourceRows: regionalNormalization
      ? [
          ...new Set(
            regionalNormalization.replacements.flatMap(
              (replacement) => replacement.sourceRows,
            ),
          ),
        ]
      : [],
    unresolvedRegionalVariantCount:
      regionalNormalization?.unresolvedVariants.length ?? 0,
    repairMs: Number((performance.now() - repairStartedAt).toFixed(3)),
  };
}
