FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch first, so pip never pulls the multi-GB CUDA build.
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

RUN git clone https://github.com/myshell-ai/MeloTTS.git /opt/MeloTTS \
    && pip install --no-cache-dir -e /opt/MeloTTS \
    && python -m unidic download \
    && python -c "import nltk; nltk.download('averaged_perceptron_tagger_eng'); nltk.download('cmudict')"

RUN pip install --no-cache-dir fastapi "uvicorn[standard]" soundfile

WORKDIR /app
COPY preload.py server.py ./
# Bake the five language models (and their BERT models) into the image.
RUN python preload.py

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
