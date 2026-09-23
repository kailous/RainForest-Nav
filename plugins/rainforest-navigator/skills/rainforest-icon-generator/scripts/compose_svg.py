#!/usr/bin/env python3
"""
Compose a RainForest SVG icon from an already-prepared SVG fragment.

This helper does NOT fetch brand assets and does NOT perform AI upscaling or vectorization.
Those steps belong to the skill workflow. This script only applies the fixed RainForest
base and places trusted/prepared vector markup into the output.

Usage:
    python scripts/compose_svg.py \
      --fragment brand-fragment.svg \
      --background '#FF5000' \
      --transform 'translate(10.75 0) scale(3.65)' \
      --out result.svg

Use --foreground only when the mark is confirmed monochrome/safely invertible.
"""

from __future__ import annotations
import argparse
import re
from pathlib import Path

BASE_RECT = '<rect x="3" y="3" width="58" height="58" rx="20" fill="{background}"/>'

def inner_svg(text: str) -> str:
    m = re.search(r"<svg\b[^>]*>(.*)</svg\s*>", text, flags=re.S | re.I)
    return m.group(1).strip() if m else text.strip()

def recolor_monochrome(markup: str, color: str) -> str:
    return re.sub(
        r'fill="(?!none\b)[^"]*"',
        f'fill="{color}"',
        markup,
        flags=re.I,
    )

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fragment", required=True)
    ap.add_argument("--background", default="#E8EAED")
    ap.add_argument("--foreground", default=None)
    ap.add_argument("--transform", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    markup = inner_svg(Path(args.fragment).read_text(encoding="utf-8"))
    if args.foreground:
        markup = recolor_monochrome(markup, args.foreground)

    if args.transform:
        markup = f'<g id="brand-icon" transform="{args.transform}">\n{markup}\n</g>'
    else:
        markup = f'<g id="brand-icon">\n{markup}\n</g>'

    svg = (
        '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" '
        'xmlns="http://www.w3.org/2000/svg">\n'
        '  <!-- RainForest base -->\n'
        f'  {BASE_RECT.format(background=args.background)}\n\n'
        '  <!-- Brand icon -->\n'
        f'  {markup}\n'
        '</svg>\n'
    )
    Path(args.out).write_text(svg, encoding="utf-8")

if __name__ == "__main__":
    main()
