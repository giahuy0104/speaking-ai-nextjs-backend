"""MeloTTS over HTTP: POST /v1/audio/speech returns a 16-bit mono WAV clip."""
import io
import os
import secrets
import threading

import soundfile as sf
import torch
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from melo.api import TTS
from pydantic import BaseModel, Field

torch.set_num_threads(int(os.getenv("TORCH_THREADS", "4")))
API_KEY = os.environ["MELO_API_KEY"]

# App language code -> (MeloTTS language, speaker).
LANGUAGES = {
    "en": ("EN", "EN-US"),
    "ja": ("JP", "JP"),
    "ko": ("KR", "KR"),
    "zh": ("ZH", "ZH"),
    "fr": ("FR", "FR"),
}

models = {}
locks = {}
for code, (lang, speaker) in LANGUAGES.items():
    model = TTS(language=lang, device="cpu")
    models[code] = (model, model.hps.data.spk2id[speaker])
    # A model synthesizes one sentence at a time.
    locks[code] = threading.Lock()


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=500)
    language: str
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest, authorization: str = Header(default="")):
    if not secrets.compare_digest(authorization, f"Bearer {API_KEY}"):
        raise HTTPException(status_code=401)
    if req.language not in models:
        raise HTTPException(status_code=400, detail="unsupported language")
    model, speaker = models[req.language]
    with locks[req.language]:
        audio = model.tts_to_file(req.input, speaker, output_path=None, speed=req.speed)
    buffer = io.BytesIO()
    sf.write(buffer, audio, model.hps.data.sampling_rate, format="WAV", subtype="PCM_16")
    return Response(buffer.getvalue(), media_type="audio/wav")
