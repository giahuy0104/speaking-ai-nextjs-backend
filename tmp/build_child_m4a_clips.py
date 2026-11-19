"""Builds 6-12 s m4a clips of children's Vietnamese speech for the English ramp load test.

Joins several recordings of ONE child (0.3 s of silence between them) and keeps their
transcripts, so the k6 script can send a partial sentence to /api/conversation/preview.

Usage: python build_child_m4a_clips.py <recordings dir> <manifest.jsonl> <out dir> [count]
Writes <out dir>/<name>.m4a and <out dir>/mix.json: [{name, durationMs, transcript}].
"""
import json
import random
import subprocess
import sys
from pathlib import Path

SOURCE_DIR, MANIFEST, OUT_DIR = (Path(arg) for arg in sys.argv[1:4])
COUNT = int(sys.argv[4]) if len(sys.argv) > 4 else 40
MIN_S, MAX_S, GAP_S = 6.0, 12.0, 0.3
random.seed(20261118)


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def main() -> None:
    entries = {}
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            entries[Path(row["audio_uri"]).stem] = row
    by_speaker: dict[str, list[tuple[Path, float, str]]] = {}
    for path in sorted(SOURCE_DIR.glob("*.m4a")):
        row = entries.get(path.stem)
        if not row or not row.get("transcript"):
            continue
        seconds = duration(path)
        if 0.6 <= seconds <= 6:
            by_speaker.setdefault(row["speaker_id"], []).append((path, seconds, row["transcript"].strip()))
    print("speakers", {k: len(v) for k, v in by_speaker.items()})

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    speakers = [s for s, items in by_speaker.items() if len(items) >= 4]
    mix = []
    attempts = 0
    while len(mix) < COUNT and attempts < COUNT * 20:
        attempts += 1
        speaker = speakers[len(mix) % len(speakers)]
        pool = by_speaker[speaker][:]
        random.shuffle(pool)
        target = random.uniform(MIN_S + 0.5, MAX_S - 0.5)
        chosen, total = [], 0.0
        for item in pool:
            extra = item[1] + (GAP_S if chosen else 0)
            if total + extra > MAX_S:
                continue
            chosen.append(item)
            total += extra
            if total >= target:
                break
        if total < MIN_S:
            continue
        name = f"child-en-{len(mix) + 1:02d}"
        out = OUT_DIR / f"{name}.m4a"
        inputs, filters = [], []
        for index, (path, _, _) in enumerate(chosen):
            inputs += ["-i", str(path)]
            filters.append(f"[{index}:a]aresample=48000,aformat=channel_layouts=mono[a{index}]")
        parts = []
        for index in range(len(chosen)):
            parts.append(f"[a{index}]")
            if index < len(chosen) - 1:
                filters.append(f"anullsrc=r=48000:cl=mono,atrim=duration={GAP_S}[g{index}]")
                parts.append(f"[g{index}]")
        filters.append(f"{''.join(parts)}concat=n={len(parts)}:v=0:a=1[out]")
        subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filters), "-map", "[out]",
                        "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-ar", "48000", str(out)], check=True)
        transcript = ". ".join(t[0].upper() + t[1:] for _, _, t in chosen) + "."
        mix.append({"name": name, "durationMs": round(duration(out) * 1000), "transcript": transcript, "speaker": speaker})
    (OUT_DIR / "mix.json").write_text(json.dumps(mix, ensure_ascii=False, indent=2), encoding="utf-8")
    lengths = [clip["durationMs"] for clip in mix]
    print(f"clips {len(mix)} duration {min(lengths)}-{max(lengths)} ms")


if __name__ == "__main__":
    main()
