#!/usr/bin/env python3
"""Build every icon DimRead ships, from the procedural mark in `dimread_mark`.

Two products, one geometry (see that module's docstring for the design):

  src-tauri/icons/                app + installer icons (tauri.conf bundle.icon)
    32x32.png 128x128.png 128x128@2x.png 512x512.png icon.ico icon.icns

  src-tauri/icons/tray/           the tray STATE family, embedded by src/tray.rs
    <mode>-<day|night>-on-<dark|light>.png      8 x 2 x 2 = 32 files

The tray family is why this is a generator and not a folder of exported PNGs:
the tray glyph changes with the active display mode, the day/night phase and the
taskbar theme, and hand-drawing 32 consistent variants is not a thing anyone
should do twice. `src-tauri/src/tray.rs` embeds all 32 with `include_bytes!` and
asserts that no two are identical, so a generator bug fails the Rust build
rather than shipping a tray icon that has quietly stopped meaning anything.

Also writes `tools/assets/icon-preview/contact-sheet.png` — every tray state at
32 / 20 / 16 px over both a light and a dark taskbar strip. LOOK at it after
changing a glyph; small-size legibility is the whole job and it is not something
you can check at 512 px.

Run: python tools/assets/generate-icons.py
 (or: uv run --with pillow tools/assets/generate-icons.py)
Idempotent; safe to re-run.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dimread_mark import (  # noqa: E402  (needs the sys.path line above)
    DEFAULT_APP_MODE,
    DEFAULT_APP_PHASE,
    MODE_GLYPHS,
    render_app,
    render_tray,
)

REPO = Path(__file__).resolve().parents[2]
ICONS = REPO / "src-tauri" / "icons"
TRAY = ICONS / "tray"
PREVIEW = Path(__file__).resolve().parent / "icon-preview"

MASTER = 1024
TRAY_SIZE = 64
"""Tray PNGs are emitted at 64 px and downscaled by the OS.

Windows asks for 16 px at 100 % DPI and 32 px at 200 %; shipping 64 keeps the
150 % / 175 % scale factors (24 and 28 px) from being upscaled.
"""

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

PHASES = ("day", "night")
THEMES = ("dark", "light")


def write_app_icons() -> list[Path]:
    written: list[Path] = []
    master = render_app(DEFAULT_APP_MODE, DEFAULT_APP_PHASE, MASTER)

    def emit(size: int, name: str) -> None:
        master.resize((size, size), Image.Resampling.LANCZOS).save(ICONS / name)
        written.append(ICONS / name)

    emit(32, "32x32.png")
    emit(128, "128x128.png")
    emit(256, "128x128@2x.png")
    emit(512, "512x512.png")

    members = [
        master.resize((size, size), Image.Resampling.LANCZOS) for size in ICO_SIZES
    ]
    ico_path = ICONS / "icon.ico"
    members[-1].save(
        ico_path,
        format="ICO",
        sizes=[(size, size) for size in ICO_SIZES],
        append_images=members[:-1],
    )
    written.append(ico_path)

    icns_path = ICONS / "icon.icns"
    master.save(icns_path, format="ICNS")
    written.append(icns_path)
    return written


def write_tray_icons() -> list[Path]:
    written: list[Path] = []
    for mode in MODE_GLYPHS:
        for phase in PHASES:
            for theme in THEMES:
                path = TRAY / f"{mode}-{phase}-on-{theme}.png"
                render_tray(mode, phase, theme, TRAY_SIZE).save(path)
                written.append(path)
    return written


def write_contact_sheet() -> Path:
    """A legibility proof sheet: every tray state at the sizes Windows asks for."""
    modes = list(MODE_GLYPHS)
    cell, label_w, header = 112, 190, 150
    rows = [(phase, theme) for phase in PHASES for theme in THEMES]
    sheet = Image.new(
        "RGBA",
        (label_w + cell * len(modes) + 20, header + cell * len(rows) + 20),
        (233, 235, 241, 255),
    )
    d = ImageDraw.Draw(sheet)
    d.text((20, 24), "DimRead tray icon states", fill=(18, 20, 32, 255))
    d.text(
        (20, 44),
        "each cell: 32 px, then 20 px and 16 px (both shown at 2x)",
        fill=(90, 95, 115, 255),
    )
    for i, mode in enumerate(modes):
        d.text((label_w + i * cell + 8, header - 18), mode, fill=(18, 20, 32, 255))

    for r, (phase, theme) in enumerate(rows):
        y = header + r * cell
        strip = (17, 18, 24, 255) if theme == "dark" else (245, 245, 248, 255)
        d.rectangle([label_w, y, label_w + cell * len(modes), y + cell - 8], fill=strip)
        d.text((20, y + cell // 2 - 8), f"{phase} / on {theme}", fill=(18, 20, 32, 255))
        for i, mode in enumerate(modes):
            x = label_w + i * cell
            sheet.alpha_composite(
                render_tray(mode, phase, theme, 32).resize((64, 64), Image.NEAREST),
                (x + 4, y + 6),
            )
            sheet.alpha_composite(
                render_tray(mode, phase, theme, 20).resize((40, 40), Image.NEAREST),
                (x + 72, y + 10),
            )
            sheet.alpha_composite(
                render_tray(mode, phase, theme, 16).resize((32, 32), Image.NEAREST),
                (x + 74, y + 58),
            )

    sheet.alpha_composite(render_app(DEFAULT_APP_MODE, DEFAULT_APP_PHASE, 96), (20, 66))
    path = PREVIEW / "contact-sheet.png"
    sheet.save(path)
    return path


def main() -> None:
    for directory in (ICONS, TRAY, PREVIEW):
        directory.mkdir(parents=True, exist_ok=True)

    app_icons = write_app_icons()
    tray_icons = write_tray_icons()
    sheet = write_contact_sheet()

    print(f"{len(app_icons)} app icons:")
    for path in app_icons:
        print(f"  {path}")
    print(f"{len(tray_icons)} tray state icons in {TRAY}")
    print(f"contact sheet: {sheet}")


if __name__ == "__main__":
    main()
