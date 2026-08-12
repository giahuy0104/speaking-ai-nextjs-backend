type FetchLike = typeof fetch;

export type UserAudioUploadInput = {
  conversationId: string;
  clientId: string;
  sessionId: string;
  audio: Blob;
  fileName: string;
  mimeType: string;
};

type UserAudioUploadOptions = {
  fetchImpl?: FetchLike;
  retryDelaysMs?: readonly number[];
  delayImpl?: (delayMs: number) => Promise<void>;
};

export type UserAudioUploadResult = {
  conversationId: string;
  userAudioUrl: string;
  requestId?: string;
};

const defaultRetryDelaysMs = [0, 500, 1_500, 3_000] as const;

function delay(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  return typeof body?.error?.message === "string"
    ? body.error.message
    : `Request failed with status ${response.status}`;
}

function createUploadFormData(input: UserAudioUploadInput) {
  const formData = new FormData();
  formData.append("audio", input.audio, input.fileName);
  formData.append("clientId", input.clientId);
  formData.append("sessionId", input.sessionId);
  formData.append("mimeType", input.mimeType);
  return formData;
}

export async function uploadConversationUserAudioAfterResponse(
  input: UserAudioUploadInput,
  options: UserAudioUploadOptions = {},
) {
  if (!input.clientId || !input.sessionId || input.audio.size <= 0) {
    throw new Error("Thiếu audio hoặc định danh lượt nói để lưu Cloudinary.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
  const delayImpl = options.delayImpl ?? delay;
  let lastError: Error | undefined;

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await delayImpl(delayMs);
    }

    let response: Response;
    try {
      response = await fetchImpl(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/user-audio`,
        {
          method: "POST",
          body: createUploadFormData(input),
        },
      );
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Không gửi được audio người dùng.");
      continue;
    }

    if (response.ok) {
      return (await response.json()) as UserAudioUploadResult;
    }

    lastError = new Error(await responseError(response));
    if (response.status === 400 || response.status === 413) {
      throw lastError;
    }
  }

  throw lastError ?? new Error("Không gửi được audio người dùng.");
}
