"""Cover images: the still frame of a YouTube video, and the podcast's cover art.

Drawn with Pillow in the app's colors and fonts (Fraunces for the title, Instrument Sans for the
rest; both under the SIL Open Font License, bundled in `fonts/`). The publish dialog shows a preview
laid out the same way: church name, title, main passage, date.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONTS = Path(__file__).parent / "fonts"

SIDEBAR = "#14201D"
GROUND = "#F6F3EC"
SIDEBAR_MUTED = "#93A19A"
SIDEBAR_BODY = "#C9D1CB"
AMBER = "#E19A1F"
SPRUCE = "#1F5C52"


def _fraunces(size: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(FONTS / "Fraunces.ttf"), size)
    # Axes: optical size, weight, softness, wonky. SemiBold at display size, no wonky letters.
    font.set_variation_by_axes([min(144, max(9, size)), 600, 0, 0])
    return font


def _sans(size: int, weight: str = "SemiBold") -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(FONTS / "InstrumentSans.ttf"), size)
    font.set_variation_by_name(weight)
    return font


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    """Greedy word wrap. A single word wider than the line is left whole."""
    lines: list[str] = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if line and draw.textlength(candidate, font=font) > max_width:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def _fit_title(draw, text: str, max_width: int, max_lines: int, sizes: range):
    """The largest size at which the title fits in `max_lines`; the smallest size, cut, otherwise."""
    for size in sizes:
        font = _fraunces(size)
        lines = wrap(draw, text, font, max_width)
        if len(lines) <= max_lines:
            return font, lines
    font = _fraunces(sizes[-1])
    lines = wrap(draw, text, font, max_width)[:max_lines]
    while lines and draw.textlength(lines[-1] + "…", font=font) > max_width:
        lines[-1] = lines[-1].rsplit(" ", 1)[0] if " " in lines[-1] else lines[-1][:-1]
    lines[-1] += "…"
    return font, lines


def render_cover(
    out: Path,
    *,
    church: str,
    title: str,
    passage: str | None,
    date: str | None,
    size: tuple[int, int] = (1280, 720),
) -> Path:
    """The video's still frame: church name, title, main passage and date on the dark sidebar color."""
    width, height = size
    scale = width / 1280
    image = Image.new("RGB", size, SIDEBAR)
    draw = ImageDraw.Draw(image)
    left = round(104 * scale)
    max_width = width - left - round(96 * scale)

    draw.rectangle([0, 0, round(10 * scale), height], fill=AMBER)
    church_font = _sans(round(26 * scale))
    draw.text((left, round(84 * scale)), church.upper(), font=church_font, fill=SIDEBAR_MUTED)

    font, lines = _fit_title(
        draw,
        title.strip() or "Sermon",
        max_width,
        3,
        range(round(78 * scale), round(44 * scale), -2),
    )
    line_height = round(font.size * 1.12)
    meta_lines = [(t, f, c) for t, f, c in (
        (passage, _sans(round(38 * scale)), AMBER),
        (date, _sans(round(30 * scale), "Medium"), SIDEBAR_BODY),
    ) if t]  # fmt: skip
    meta_height = sum(round(f.size * 1.5) for _, f, _ in meta_lines)
    block = line_height * len(lines) + (round(34 * scale) if meta_lines else 0) + meta_height
    y = max(round(150 * scale), (height - block) // 2 + round(20 * scale))
    for line in lines:
        draw.text((left, y), line, font=font, fill=GROUND)
        y += line_height
    y += round(34 * scale)
    for text, meta_font, color in meta_lines:
        draw.text((left, y), text, font=meta_font, fill=color)
        y += round(meta_font.size * 1.5)

    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out, "PNG", optimize=True)
    return out


def render_artwork(out: Path, *, title: str, church: str, size: int = 3000) -> Path:
    """Podcast cover art. Apple asks for a square between 1400 and 3000 pixels."""
    scale = size / 3000
    image = Image.new("RGB", (size, size), SIDEBAR)
    draw = ImageDraw.Draw(image)
    margin = round(260 * scale)
    max_width = size - 2 * margin

    draw.rectangle(
        [margin, margin, margin + round(220 * scale), margin + round(28 * scale)], fill=AMBER
    )
    font, lines = _fit_title(
        draw,
        title.strip() or church,
        max_width,
        4,
        range(round(330 * scale), round(150 * scale), -10),
    )
    line_height = round(font.size * 1.1)
    y = size - margin - line_height * len(lines) - round(240 * scale)
    for line in lines:
        draw.text((margin, y), line, font=font, fill=GROUND)
        y += line_height
    church_font = _sans(round(110 * scale))
    draw.text(
        (margin, size - margin - round(130 * scale)), church, font=church_font, fill=SIDEBAR_MUTED
    )

    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out, "PNG", optimize=True)
    return out
