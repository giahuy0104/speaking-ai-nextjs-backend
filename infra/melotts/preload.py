"""Downloads every model the server loads, at image build time."""
from melo.api import TTS

LANGUAGES = [("EN", "EN-US"), ("JP", "JP"), ("KR", "KR"), ("ZH", "ZH"), ("FR", "FR")]

for lang, speaker in LANGUAGES:
    model = TTS(language=lang, device="cpu")
    # One synthesis also pulls the language's BERT model.
    model.tts_to_file("Hello", model.hps.data.spk2id[speaker], output_path=None)
    print("loaded", lang, flush=True)
