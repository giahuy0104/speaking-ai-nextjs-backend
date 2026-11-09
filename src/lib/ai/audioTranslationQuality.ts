// Conservative guard, not a semantic correctness score. Proper names and
// borrowed words may remain Latin; accented Vietnamese and other scripts must
// never be presented to clients as a completed English translation.
export function isEnglishAudioTranslation(text: string) {
  return /[a-z]/i.test(text) &&
    !/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/iu.test(text) &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(text);
}

export function isSuspiciousAudioTranscript(text: string) {
  // Common Whisper hallucinations on quiet/unclear child recordings.
  return /(?:subscribe|đăng k[ýí]|ghiền mì gõ|lalaschool|không bỏ lỡ.{0,30}video)/iu.test(text);
}
