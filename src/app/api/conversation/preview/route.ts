import { after } from "next/server";
import { resolveFastEnglishSentence } from "@/lib/ai/llm";
import { bypassesAudioCache } from "@/lib/ai/loadTestPersistence";
import { getPreviewSpeculation } from "@/lib/ai/previewSpeculation";
import { getEnglishAudioCacheUrl } from "@/lib/ai/tts";
import type { AsrMode, PracticeContext, TargetLanguage } from "@/types/conversation";
import { toErrorResponse } from "@/lib/errors";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { getRequestId, logEvent } from "@/lib/observability";

export const runtime = "nodejs";

const contexts = new Set<PracticeContext>(["home", "school", "outside"]);
const targetLanguages = new Set<unknown>(["en", "zh", "ja", "ko", "fr"]);
const speechAsrModes = new Set<unknown>(["android_streaming", "browser_streaming"]);

/** Optional for now: apps that do not send it reuse their last final turn's language. */
function optionalTargetLanguage(value: unknown) {
  return targetLanguages.has(value) ? (value as TargetLanguage) : undefined;
}

function optionalSpeechAsrMode(value: unknown) {
  return speechAsrModes.has(value) ? (value as AsrMode) : undefined;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      clientId?: string;
      context?: PracticeContext;
      childAge?: number;
      sourceText?: string;
      targetLanguage?: unknown;
      asrMode?: unknown;
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
    const childAge = Number.isInteger(body?.childAge) ? (body?.childAge as number) : 6;
    // After the response: when this text is still the latest one, translate the
    // turn now so the final /api/conversation request can reuse it.
    const requestId = getRequestId(request);
    after(() => getPreviewSpeculation().speculate({
      requestId,
      clientId: access.clientId,
      context,
      childAge,
      sourceText,
      targetLanguage: optionalTargetLanguage(body?.targetLanguage),
      asrMode: optionalSpeechAsrMode(body?.asrMode),
    }).catch((error: unknown) => {
      logEvent("warn", "preview_speculation_failed", { requestId, error });
    }));
    // Load tests never read the rule and text caches (see loadTestPersistence.ts).
    if (bypassesAudioCache(access.clientId)) {
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

    // Partial transcripts can change several times during one utterance. This
    // response only preloads audio that already exists; the only TTS a preview can
    // start is the early translation above (AUDIO_PREVIEW_SPECULATION_ENABLED).
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
