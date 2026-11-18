// Live check (local Google ADC): short English -> Neural2 MP3 clip, long -> Chirp 3 HD WAV stream.
import { requestEnglishSpeechAudio } from "../src/lib/ai/englishSpeech";

process.env.AUDIO_ENGLISH_TTS_PROVIDER = "google";
process.env.GOOGLE_TTS_CLIP_VOICE_EN = "Neural2-F";

async function main() {
  for (const text of ["I like ice cream!", "This weekend my family plans to go to the beach to relax and watch the sunset."]) {
    const started = performance.now();
    const speech = await requestEnglishSpeechAudio(text);
    const headersMs = Math.round(performance.now() - started);
    const bytes = (await speech.response.arrayBuffer()).byteLength;
    console.log(JSON.stringify({ chars: text.length, voice: speech.profile.voice, extension: speech.profile.extension,
      contentType: speech.response.headers.get("content-type"), firstAudioMs: headersMs,
      totalMs: Math.round(performance.now() - started), bytes }));
  }
}
main().catch(error => { console.error(error); process.exit(1); });
