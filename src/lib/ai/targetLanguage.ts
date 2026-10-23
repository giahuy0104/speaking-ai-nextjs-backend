import { AppError } from "@/lib/appError";
import type { TargetLanguage } from "@/types/conversation";

export function parseTargetLanguage(value: unknown): TargetLanguage {
  if (value === undefined || value === null || value === "en") return "en";
  if (value === "zh" || value === "ja" || value === "ko" || value === "fr") return value;
  throw new AppError("BAD_REQUEST", "Ngôn ngữ dịch không được hỗ trợ.", 400);
}
