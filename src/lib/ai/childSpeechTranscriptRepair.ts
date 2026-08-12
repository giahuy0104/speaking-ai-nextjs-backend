import { repairVietnameseChildTranscript } from "./transcriptRepair";
import { repairVietnameseTranscriptWithCorpus } from "./transcriptCorpusRepair";
import { normalizeRegionalVietnameseOutsideCorpus } from "./regionalVocabularyNormalizer";

export function repairVietnameseChildSpeechLayers(text: string) {
  const subjectRepaired = repairVietnameseChildTranscript(text);
  const corpusRepair = repairVietnameseTranscriptWithCorpus(subjectRepaired);
  const regionalNormalization = corpusRepair.ruleId || corpusRepair.repaired
    ? null
    : normalizeRegionalVietnameseOutsideCorpus(corpusRepair.text);
  const regionalVocabularySourceRows = regionalNormalization
    ? [
        ...new Set(
          regionalNormalization.replacements.flatMap(
            (replacement) => replacement.sourceRows,
          ),
        ),
      ]
    : [];

  return {
    text: regionalNormalization?.text ?? corpusRepair.text,
    applied:
      subjectRepaired !== text ||
      corpusRepair.repaired ||
      regionalNormalization?.normalized === true,
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
    regionalVocabularySourceRows,
    unresolvedRegionalVariantCount:
      regionalNormalization?.unresolvedVariants.length ?? 0,
  };
}
