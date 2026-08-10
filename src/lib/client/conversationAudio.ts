"use client";

import type {
  BenchmarkMetadata,
  PracticeContext,
} from "@/types/conversation";

type FetchLike = typeof fetch;

type PostCompleteAudioConversationOptions = {
  audio: Blob;
  context: PracticeContext;
  benchmark?: BenchmarkMetadata;
  childAge?: number;
  fileName?: string;
  fetchImpl?: FetchLike;
};

const audioFileExtensions: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/x-wav": "wav",
};

export function getCompleteAudioFileName(mimeType: string) {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const knownExtension = audioFileExtensions[normalized];
  if (knownExtension) return `speech.${knownExtension}`;

  const subtype = normalized.match(
    /^audio\/(?:x-)?([a-z0-9][a-z0-9.+-]{0,63})$/,
  )?.[1];
  const safeExtension = subtype?.replace(/[+.]/g, "-");
  return safeExtension ? `speech.${safeExtension}` : "speech.webm";
}

/**
 * Sends a complete audio file through the same server-side ASR -> English ->
 * TTS pipeline used by the complete-file fallback of “Bắt đầu nói”.
 */
export function postCompleteAudioConversation({
  audio,
  context,
  benchmark,
  childAge = 6,
  fileName = getCompleteAudioFileName(audio.type),
  fetchImpl = fetch,
}: PostCompleteAudioConversationOptions) {
  const formData = new FormData();
  formData.append("context", context);
  formData.append("childAge", String(childAge));
  if (benchmark) {
    formData.append("benchmark", JSON.stringify(benchmark));
  }
  formData.append("audio", audio, fileName);

  return fetchImpl("/api/conversation", {
    method: "POST",
    body: formData,
  });
}
