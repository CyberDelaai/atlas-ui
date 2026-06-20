#!/usr/bin/env python3
"""Bump the ATLAS app version (X.Y.Z).

Usage:
    python3 bump_version.py {x|y|z}

Bumps the chosen component and resets the lower ones to 0 (semver-style):
    x  ->  (X+1).0.0
    y  ->  X.(Y+1).0
    z  ->  X.Y.(Z+1)

ATLAS has no single source-of-truth constant — the version is hardcoded in
THREE spots, all kept in sync here:
  - line-1 comment        <!-- ATLAS vX.Y.Z -->              (index.html)
  - header tag span       <span id="tagVersion">X.Y.Z</span> (index.html)
  - version-morph const   const VER = ' // vX.Y.Z';          (js/header.js)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
HEADER_JS = ROOT / "js" / "header.js"

# (compiled pattern, file it lives in)
PATTERNS = [
    (re.compile(r'(<!-- ATLAS v)(\d+)\.(\d+)\.(\d+)( -->)'), INDEX),
    (re.compile(r'(<span id="tagVersion">)(\d+)\.(\d+)\.(\d+)(</span>)'), INDEX),
    (re.compile(r"(const VER = ' // v)(\d+)\.(\d+)\.(\d+)(';)"), HEADER_JS),
]


def main():
    arg = sys.argv[1].lower() if len(sys.argv) == 2 else ""
    if arg not in ("x", "y", "z"):
        sys.exit("usage: python3 bump_version.py {x|y|z}")

    # The displayed span is the canonical reading; fall back to the comment.
    index_text = INDEX.read_text(encoding="utf-8")
    m = PATTERNS[1][0].search(index_text) or PATTERNS[0][0].search(index_text)
    if not m:
        sys.exit("error: version not found in index.html")

    x, y, z = (int(m.group(i)) for i in (2, 3, 4))
    old = f"{x}.{y}.{z}"
    if arg == "x":
        x, y, z = x + 1, 0, 0
    elif arg == "y":
        y, z = y + 1, 0
    else:
        z += 1
    new = f"{x}.{y}.{z}"

    # group patterns by file so each file is read/written once
    total = 0
    cache = {}
    for p, path in PATTERNS:
        cache.setdefault(path, path.read_text(encoding="utf-8"))
        cache[path], n = p.subn(rf"\g<1>{new}\g<5>", cache[path])
        total += n
        if n == 0:
            print(f"warning: pattern not found/updated in {path.name}: {p.pattern}")
    for path, text in cache.items():
        path.write_text(text, encoding="utf-8")
    print(f"version: {old} -> {new}  ({total}/3 occurrences updated)")


if __name__ == "__main__":
    main()
