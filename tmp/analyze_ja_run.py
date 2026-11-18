"""Summarize one k6 mobile-flow run from the dev backend + nginx JSON logs.

Usage (on the VPS): python3 analyze_ja_run.py backend.jsonl nginx.jsonl STREAM_MIN_CHARS
backend.jsonl lines look like {"_c":3000,"_l":<original line>}.
"""
import collections
import json
import re
import sys

backend_path, nginx_path, stream_min = sys.argv[1], sys.argv[2], int(sys.argv[3])


def pct(values, q):
    if not values:
        return "-"
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * q))]


def dist(values):
    return f"n={len(values)} p50={pct(values, .5)} p90={pct(values, .9)} p95={pct(values, .95)} max={pct(values, 1)}"


events = collections.Counter()
modes = collections.Counter()
chars = {"clip": [], "stream": []}
ttfa = {"clip": [], "stream": []}
llm = {"clip": [], "stream": []}
unavailable = collections.Counter()
unavailable_by_min = collections.Counter()
stream_by_min = collections.Counter()
clip_by_min = collections.Counter()
first_chunk = []
providers = collections.Counter()
clip_fallback = collections.Counter()
text_fallback = collections.Counter()
pipe_errors = 0
pipe_reasons = collections.Counter()
lengths_by_req = {}
mode_by_req = {}
k6_reqs = 0

lines = open(backend_path, encoding="utf-8", errors="replace").read().splitlines()
for raw in lines:
    match = re.match(r'^\{"_c":(\d+),"_l":(.*)\}$', raw)
    if not match:
        continue
    body = match.group(2)
    if "failed to pipe response" in body:
        pipe_errors += 1
    reason = re.search(r"reason: '([a-z_]+)'", body)
    if reason:
        pipe_reasons[reason.group(1)] += 1
    try:
        entry = json.loads(body)
    except ValueError:
        continue
    if not isinstance(entry, dict):
        continue
    event = entry.get("event")
    events[event] += 1
    minute = entry.get("timestamp", "")[11:16]
    if event == "target_translation_completed":
        providers[entry.get("provider")] += 1
        lengths_by_req[entry.get("requestId")] = entry.get("normalizedLength", 0)
    elif event == "target_translation_pipeline_completed":
        mode = entry.get("audioMode")
        modes[mode] += 1
        mode_by_req[entry.get("requestId")] = mode
        if str(entry.get("requestId", "")).startswith("k6-"):
            k6_reqs += 1
        latency = entry.get("latency", {})
        if mode in ttfa:
            ttfa[mode].append(latency.get("timeToFirstAudioMs", 0))
            llm[mode].append(latency.get("llmMs", 0))
            (stream_by_min if mode == "stream" else clip_by_min)[minute] += 1
    elif event == "target_translation_audio_unavailable":
        unavailable[(entry.get("reason"), entry.get("model"), mode_by_req.get(entry.get("requestId")))] += 1
        unavailable_by_min[minute] += 1
    elif event == "target_speech_stream_first_chunk":
        first_chunk.append(entry.get("latencyMs", 0))
    elif event == "target_speech_clip_provider_fallback":
        err = entry.get("error", {})
        clip_fallback[(entry.get("reason") or err.get("message", ""))[:80]] += 1
    elif event == "target_translation_provider_fallback":
        text_fallback[(entry.get("from"), entry.get("to"), entry.get("reason"))] += 1

for request_id, mode in mode_by_req.items():
    if mode in chars and request_id in lengths_by_req:
        chars[mode].append(lengths_by_req[request_id])

print("== backend events")
for name, count in events.most_common(30):
    print(f"  {count:6} {name}")
print(f"== pipelines: {sum(modes.values())} (k6 {k6_reqs}) modes={dict(modes)} stream_min_chars={stream_min}")
for mode in ("clip", "stream"):
    values = chars[mode]
    print(f"  {mode}: requests={len(values)} chars={sum(values)} avg={sum(values) / max(1, len(values)):.1f}")
    print(f"    server time-to-first-audio {dist(ttfa[mode])}")
    print(f"    server llm                 {dist(llm[mode])}")
print(f"== stream first chunk {dist(first_chunk)}")
print(f"== text providers {dict(providers)} fallbacks {dict(text_fallback)}")
print(f"== clip provider fallbacks (DeepInfra -> Google) {sum(clip_fallback.values())} {dict(clip_fallback)}")
print(f"== audio unavailable {sum(unavailable.values())} {dict(unavailable)}")
print(f"   by minute {dict(sorted(unavailable_by_min.items()))}")
print(f"== stream per minute {dict(sorted(stream_by_min.items()))}")
print(f"== clip per minute {dict(sorted(clip_by_min.items()))}")
print(f"== 'failed to pipe response' {pipe_errors} reasons {dict(pipe_reasons)}")

status = collections.Counter()
errors = collections.Counter()
error_by_min = collections.Counter()
for raw in open(nginx_path, encoding="utf-8", errors="replace"):
    try:
        entry = json.loads(raw)
    except ValueError:
        continue
    uri = entry["uri"].split("?")[0]
    uri = re.sub(r"conv_[0-9a-f]+", "conv_*", uri)
    key = f'{entry["method"]} {uri}'
    status[(key, entry["status"])] += 1
    if entry["status"] >= 400:
        errors[(key, entry["status"], entry.get("upstreamStatus"))] += 1
        error_by_min[(key, entry["timestamp"][11:16])] += 1
print("== nginx status")
for (key, code), count in sorted(status.items(), key=lambda item: -item[1]):
    print(f"  {count:6} {code} {key}")
print("== nginx errors (upstream statuses)")
for (key, code, upstream), count in sorted(errors.items(), key=lambda item: -item[1]):
    print(f"  {count:6} {code} {key} upstream={upstream}")
print("== nginx errors by minute")
for (key, minute), count in sorted(error_by_min.items()):
    print(f"  {minute} {count:5} {key}")
