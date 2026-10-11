"""Cut LXGW WenKai Lite down to a web font T³ can ship.

The release `LXGWWenKaiLite-Regular.ttf` is 13.2 MB, which is not a font file — it is a
download. Subsetting it to the common CJK sets gives 3.9 MB of woff2 that covers everything
this library actually writes, and the sets are the thing that is fixed here: growing the
library does not change what needs re-cutting, only whether the same command should run again.

    python tools/fonts/subset-wenkai.py <LXGWWenKaiLite-Regular.ttf> <out.woff2>

The character set is GB/T 2312 (simplified) + Big5 (traditional) + JIS X 0208 and its
Windows extensions (Japanese) + kana + CJK punctuation + Latin-1 + general punctuation,
symbols and dingbats. Those three legacy sets are used instead of a character-frequency list
because they are reproducible and their promise is checkable: measured over the library's own
628575 characters the result misses 0.288%, and every miss is Korean or an emoji the full
13.2 MB font has no glyph for either.

Kana and JIS X 0208 are load-bearing, not padding. The first attempt used GB/T 2312 alone and
missed 1.77% of the library's characters — and the top of that list was 語, ー, 訳, 無, 漢, 編:
this is a library of Japanese work titles, and a simplified-Chinese-only set leaves one glyph
per title to the system font.

Needs `fonttools` and `brotli` on the interpreter that runs it.
"""
import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTFont


def decodable(codec: str, lead_lo: int, lead_hi: int) -> set[str]:
    """Every single character the codec can decode from the given lead-byte range."""
    out: set[str] = set()
    for lead in range(lead_lo, lead_hi + 1):
        for trail in range(0x40, 0xFF):
            try:
                decoded = bytes([lead, trail]).decode(codec)
            except (UnicodeDecodeError, ValueError):
                continue
            if len(decoded) == 1:
                out.add(decoded)
    return out


def character_set(font_codepoints: set[int]) -> set[str]:
    chars: set[str] = set()
    for lo, hi in (
        (0x20, 0x7E),      # ASCII
        (0xA0, 0xFF),      # Latin-1 — accented names, the middle dot
        (0x2000, 0x206F),  # general punctuation — — – … “ ” ‘ ’
        (0x2070, 0x209F),
        (0x20A0, 0x20CF),  # currency
        (0x2100, 0x214F),  # letterlike
        (0x2190, 0x21FF),  # arrows
        (0x2200, 0x22FF),  # mathematical operators
        (0x2460, 0x24FF),  # enclosed alphanumerics
        (0x25A0, 0x25FF),  # geometric shapes
        (0x2600, 0x27BF),  # misc symbols and dingbats (♡ ♥ live here)
        (0x3000, 0x303F),  # CJK punctuation
        (0x3040, 0x30FF),  # hiragana and katakana
        (0x31F0, 0x31FF),  # katakana phonetic extensions
        (0xFE10, 0xFE1F),
        (0xFE30, 0xFE4F),
        (0xFF00, 0xFFEF),  # fullwidth and halfwidth forms
    ):
        chars.update(chr(cp) for cp in range(lo, hi + 1))

    chars |= decodable("gb2312", 0xA1, 0xF8)
    chars |= decodable("big5", 0xA1, 0xFA)
    chars |= decodable("cp932", 0x81, 0xFC)

    # A character the font cannot draw would fall back to the system face anyway, so keeping it
    # in the request only inflates the file.
    return {c for c in chars if ord(c) in font_codepoints and (c.strip() or c == " ")}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    chars = character_set(set(TTFont(source).getBestCmap()))
    text_file = target.with_suffix(".chars.txt")
    text_file.write_text("".join(sorted(chars)), encoding="utf-8")
    print(f"{len(chars)} characters -> {text_file}")

    subprocess.run(
        [
            sys.executable, "-m", "fontTools.subset", str(source),
            f"--text-file={text_file}", f"--output-file={target}", "--flavor=woff2",
            # `palt`/`vpal`/`vert`/`halt` position CJK punctuation; dropping them shifts it.
            "--layout-features=kern,liga,palt,vpal,vert,halt,vhal",
            "--no-hinting",
        ],
        check=True,
    )
    print(f"{target} {target.stat().st_size} bytes ({target.stat().st_size / 1048576:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
