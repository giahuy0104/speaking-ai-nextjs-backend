export type ChildSpeechTestMode = "text_replay" | "cloudflare_audio";

export type ChildSpeechTestResponse = {
  requestId: string;
  mode: ChildSpeechTestMode;
  expectedText: string;
  rawAsr: string;
  correctedText: string;
  matchedExpected: boolean;
  qualityIssue?: string;
  lessonId?: string;
  context: "home" | "school" | "outside";
  childAge: number;
  inputLabel?: string;
  audioBytes?: number;
  asr: {
    model?: string;
    wordCount?: number;
    latencyMs: number;
  };
  repair: {
    subjectRepairApplied: boolean;
    corpusRepairApplied: boolean;
    regionalVocabularyApplied: boolean;
    strategy?: string;
    score?: number;
    margin?: number;
    ruleId?: string;
    correctionId?: string;
    latencyMs: number;
  };
  totalMs: number;
  testedAt: string;
};
