import { resolveFastEnglishSentence } from "@/lib/ai/llm";
import { getEnglishAudioCacheUrl } from "@/lib/ai/tts";
import type { PracticeContext } from "@/types/conversation";
import { toErrorResponse } from "@/lib/errors";
import { isVietnameseToEnglish, parseLanguagePair } from "@/lib/ai/targetLanguage";
import { requireInstallationAccess } from "@/lib/installationAuth";

export const runtime = "nodejs";

const contexts = new Set<PracticeContext>(["home", "school", "outside"]);

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      clientId?: string;
      context?: PracticeContext;
      childAge?: number;
      sourceText?: string;
      sourceLanguage?: unknown;
      targetLanguage?: unknown;
    } | null;
    const sourceText = body?.sourceText?.trim() ?? "";
    const context = body?.context;

    if (
      !sourceText ||
      sourceText.length > 500 ||
      !context ||
      !contexts.has(context)
    ) {
      return Response.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Dữ liệu xem trước không hợp lệ.",
          },
        },
        { status: 400 },
      );
    }
    const access = await requireInstallationAccess(request, body?.clientId);
    // The fast preview is the Vietnamese → English rule/cache path only.
    if (!isVietnameseToEnglish(parseLanguagePair(body?.sourceLanguage, body?.targetLanguage))) {
      return Response.json({ matched: false });
    }

    const match = await resolveFastEnglishSentence(
      sourceText,
      context,
      body?.childAge ?? 6,
      access.clientId,
    );

    if (!match) {
      return Response.json({ matched: false });
    }

    // Partial transcripts can change several times during one utterance. Only
    // preload audio that already exists so previews never trigger extra TTS calls.
    const audioUrl = await getEnglishAudioCacheUrl(match.englishText);
    return Response.json({
      matched: true,
      sourceText,
      englishText: match.englishText,
      textSource: match.source,
      matchedRule: match.matchedRule,
      audioUrl,
      audioSource: audioUrl ? "cache" : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
