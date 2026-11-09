import { handleAudioTranslation } from "@/lib/ai/audioTranslationRoute";

export const runtime = "nodejs";
export const maxDuration = 35;
export async function POST(request: Request) {
  return handleAudioTranslation(request);
}
