import type { PracticeContext, TargetLanguage } from "@/types/conversation";

export { PROMPT_VERSION } from "./translationPolicy";

export const contextLabels: Record<PracticeContext, string> = {
  home: "O nha",
  school: "Truoc / sau gio hoc",
  outside: "Ra ngoai",
};

export const sampleVietnameseByContext: Record<PracticeContext, string[]> = {
  home: ["Con muon uong nuoc", "Con doi roi", "Giup con voi"],
  school: ["Con quen sach roi", "Con can but chi", "Con khong hieu bai"],
  outside: ["Con muon mua cai nay", "Con bi lac", "Con can giup do"],
};

export function buildTargetLanguageInstruction(
  language: Exclude<TargetLanguage, "en">,
  context: PracticeContext,
  childAge = 6,
) {
  const target = {
    zh: "natural Simplified Chinese written in Chinese characters, without pinyin",
    ja: "natural Japanese written in Japanese script, without romaji",
    ko: "natural Korean written in Hangul",
    fr: "natural French",
  }[language];
  return `Translate the child's Vietnamese utterance directly into ${target}.
Preserve the speaker, addressee, kinship terms, negation, action, object, ownership, quantity, time, place, and whether it is a statement, question or request.
Translate every sentence, including incomplete ones, without completing the child's thought.
Do not answer the child, add information, change the meaning, or translate through English.
Return only the translation, without a label, quotation marks, romanization or explanation.
Context for resolving genuine ambiguity only: ${contextLabels[context]}; child_age=${childAge}.`;
}

export function buildEnglishInstruction(context: PracticeContext, childAge = 6) {
  return `You translate a child's Vietnamese utterance into faithful, natural, grammatically correct English.

Hard requirements:
- Preserve the speaker, addressee, pronouns, kinship terms, negation, modality, action, object, ownership, quantity, time and place stated in the source.
- Preserve the original speech act: statement, question, request, permission, desire, refusal or command.
- Do not summarize, simplify, paraphrase, answer the utterance, infer missing information, add politeness, or change a statement into a question (or a question into a statement).
- If the source is incomplete, translate only the words and meaning that are present. Do not complete the thought for the child.
- Interpret Vietnamese discourse particles from their grammatical role, not by a literal dictionary gloss. In a request such as "chở con đi học với", sentence-final "với" marks a polite request: use "please", never "too" unless the source explicitly means "cũng/cùng".
- When the child points to text, homework or an object, "chỗ này" means "this part/this" unless the source clearly refers to a physical place.
- "Cây bút" means "pen". Use "pencil", "colored pencil", "crayon" or another subtype only when that subtype is stated in Vietnamese.
- Apply these mandatory child-speech mappings when the stated meaning is present: bố/ba = Dad; mẹ/má = Mom; ông = Grandpa; bà/ngoại/nội = Grandma; công viên = park; trường = school.
- The child may use Northern, Central or Southern Vietnamese vocabulary. Interpret regional words from the complete sentence context. Never replace a valid homonym merely because it resembles a regional variant.
- Preserve every explicit color, number, time and place. Never replace it with a related or more specific concept. For example, màu tím = purple and công viên = park, never kindergarten.
- Return exactly one English translation. English only, without quotation marks, labels, notes or explanations.
- The utterance may contain multiple sentences. Translate all of them, preserving every statement; one translation does not mean one sentence.

Contrastive examples:
Vietnamese: Mẹ ơi, con muốn mua cái này.
English: Mom, I want to buy this.
Vietnamese: Mẹ ơi, mình mua cái này được không?
English: Mom, can we buy this?
Vietnamese: Con không muốn mua cái này.
English: I don't want to buy this.
Vietnamese: Bố mua cái này cho con nhé.
English: Dad, please buy this for me.
Vietnamese: Ba ơi, chở con đi học với.
English: Dad, please take me to school.
Vietnamese: Cô ơi, chỗ này đọc thế nào vậy?
English: Teacher, how do you read this part?
Vietnamese: Mẹ ơi, con muốn mua cây bút màu xanh lá cây.
English: Mom, I want to buy a green pen.

Metadata only: context=${contextLabels[context]}; child_age=${childAge}. Use metadata only to resolve genuine ambiguity. Never add information from metadata to the translation.`;
}
