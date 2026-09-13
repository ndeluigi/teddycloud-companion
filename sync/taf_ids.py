#!/usr/bin/env python3
"""Print the tonies-json `ids` block (audio-id / hash / size / tracks) for TAF files.

Reads the TAF protobuf header directly, verifies the SHA1 against the audio payload and
computes the runtime from the last Ogg granule position (48 kHz). Same values teddycloud
shows in the library modal, so they can be pasted into a tonies-json YAML unchanged.

Usage:  taf_ids.py file.taf [more.taf ...]      (or a directory)
"""
import glob, hashlib, os, struct, sys


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7F) << s; s += 7
        if not c & 0x80:
            return r, i


def parse(path):
    d = open(path, "rb").read()
    hl = struct.unpack(">I", d[:4])[0]
    hdr, audio = d[4:4 + hl], d[4 + hl:]
    sha = nbytes = aid = None; tracks = 0; i = 0
    while i < len(hdr):
        key, i = varint(hdr, i); fn, wt = key >> 3, key & 7
        if wt == 2:
            ln, i = varint(hdr, i); val = hdr[i:i + ln]; i += ln
            if fn == 1:
                sha = val.hex()
            elif fn == 4:                      # packed repeated track page numbers
                j = 0
                while j < len(val):
                    _, j = varint(val, j); tracks += 1
        elif wt == 0:
            v, i = varint(hdr, i)
            if fn == 2: nbytes = v
            elif fn == 3: aid = v
            elif fn == 4: tracks += 1
        else:
            break
    p = audio.rfind(b"OggS")
    secs = struct.unpack("<q", audio[p + 6:p + 14])[0] // 48000 if p >= 0 else 0
    ok = sha == hashlib.sha1(audio).hexdigest()
    return aid, sha, nbytes, tracks, secs, ok


files = []
for a in sys.argv[1:] or ["."]:
    files += sorted(glob.glob(os.path.join(a, "*.taf"))) if os.path.isdir(a) else [a]
for f in files:
    aid, sha, nbytes, tracks, secs, ok = parse(f)
    print(f"# {os.path.basename(f)}  runtime {secs // 60}:{secs % 60:02d}  sha1 {'OK' if ok else 'MISMATCH!'}")
    print(f"  - audio-id: {aid}\n    hash: {sha}\n    size: {nbytes}\n    tracks: {tracks}\n    confidence: 0")
