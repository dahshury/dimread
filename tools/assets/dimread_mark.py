#!/usr/bin/env python3
r"""The DimRead brand mark, drawn procedurally.

ONE geometry, rendered into every icon the app ships. Keeping the mark as code
rather than a pile of exported PNGs is what makes the tray's 8 x 2 x 2 state
family possible: a variant is a parameter change, not a new drawing.

## The mark

A rounded **reading surface** with a **band of light** along its lower edge, and
the active **mode glyph knocked out** of the surface above it.

    +-----------+
    |    /\     |   <- surface   (constant: this is the brand)
    |   /  \    |   <- mode glyph, KNOCKED OUT (transparent)
    |           |
    |###########|   <- light band (its colour is the day/night state)
    +-----------+

Three deliberate choices, each learned from a failed round:

* **The glyph is a knockout, not a badge.** A small glyph drawn *on* the surface
  disappears at 16 px. A hole punched *through* it is maximum contrast at any
  size and survives as a flat monochrome silhouette.
* **The tray icon has no tile.** A dark rounded tile behind the mark eats ~30 %
  of a 16 px budget and, on a dark taskbar, is just a dark smudge. Only the APP
  icon (installer / taskbar button) gets the squircle tile; the tray gets the
  bare mark on transparency.
* **The band is the state, the surface is the identity.** The band renders the
  light DimRead is currently putting on the screen — pale and cool on the day
  profile, amber on the night one. The surface colour only ever changes to keep
  contrast against a light vs dark taskbar.

## Coordinates

Everything is normalised 0..1 over the mark's own box and scaled at draw time,
so the same code renders a 16 px tray glyph and a 1024 px master.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from PIL import Image, ImageDraw

# Supersampling factor. Pillow has no anti-aliased vector rasteriser, so every
# shape is drawn large and LANCZOS-downsampled; 8x is where the 16 px renders
# stop showing stair-steps on the diagonals (the pencil and the play triangle).
SUPERSAMPLE = 8

# ── Palette ─────────────────────────────────────────────────────────────────
# Two surface treatments (for a dark vs light taskbar) and two band treatments
# (day vs night). The band hues are the app's own two poles: the cool end of the
# Kelvin range and the warm end.

SURFACE_ON_DARK = (108, 124, 255, 255)  # brand blue-violet, bright enough for a dark taskbar
SURFACE_ON_LIGHT = (43, 51, 110, 255)  # deep indigo, reads solid on a light taskbar

BAND_DAY_ON_DARK = (186, 208, 255, 255)  # pale cool light
BAND_DAY_ON_LIGHT = (96, 132, 224, 255)
BAND_NIGHT_ON_DARK = (250, 176, 78, 255)  # warm amber light
BAND_NIGHT_ON_LIGHT = (214, 130, 26, 255)

# The app-icon tile (the squircle the mark sits on). Tray icons never use it.
TILE = (14, 17, 32, 255)

# ── Geometry (normalised 0..1 over the mark's box) ──────────────────────────

SURFACE_RADIUS = 0.24
"""Corner radius of the reading surface, as a fraction of its width."""

BAND_TOP = 0.70
"""Where the light band starts. The band is the bottom 30 % of the mark."""

SEAM = 0.028
"""Transparent gap between surface and band.

This is what makes the two read as separate planes — light falling ON something
rather than a two-tone block. At 16 px it survives as a single pixel, which is
exactly enough.
"""

GLYPH_BOX = (0.135, 0.105, 0.865, 0.605)
"""The knockout region: left, top, right, bottom.

The mode glyph fills this box — 73 % of the mark's width and the whole upper
plane. A glyph confined to a small badge is unreadable in the tray; this one IS
the upper surface. Every point of margin here is a point of legibility lost at
16 px, so it is cut as close to the surface's corner radius as the rounding
allows.
"""

STROKE = 0.115
"""Minimum stroke weight as a fraction of the mark's width (~2/16 at tray size).

Nothing in a glyph may be thinner than this. It is the entire reason the modes
stay apart at 16 px.
"""


@dataclass(frozen=True)
class MarkStyle:
    surface: tuple[int, int, int, int]
    band: tuple[int, int, int, int]


def mark_style(phase: str, on_theme: str) -> MarkStyle:
    """Resolve the (day|night) x (dark|light taskbar) colour pair.

    `on_theme` is the TASKBAR's theme: `dark` asks for the rendering that sits on
    a dark taskbar.
    """
    if on_theme not in ("dark", "light"):
        raise ValueError(f"on_theme must be 'dark' or 'light', got {on_theme!r}")
    if phase not in ("day", "night"):
        raise ValueError(f"phase must be 'day' or 'night', got {phase!r}")
    surface = SURFACE_ON_DARK if on_theme == "dark" else SURFACE_ON_LIGHT
    if phase == "day":
        band = BAND_DAY_ON_DARK if on_theme == "dark" else BAND_DAY_ON_LIGHT
    else:
        band = BAND_NIGHT_ON_DARK if on_theme == "dark" else BAND_NIGHT_ON_LIGHT
    return MarkStyle(surface=surface, band=band)


# ── Mode glyphs ─────────────────────────────────────────────────────────────
# Each draws into `box` (l, t, r, b) with the given colour. They are called
# twice: once to punch the knockout (transparent) and, for the app icon, that is
# it — the tile shows through.
#
# Every glyph is 1-3 shapes with no detail finer than STROKE. Checked against
# each other at 16 px: two vertical bars (pause) vs three horizontal (custom),
# a cross (game) vs a heart (health), a triangle (movie) vs a diagonal (editing),
# a notched rectangle (office) vs two arcs (reading).


def _span(box: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    left, top, right, bottom = box
    return left, top, right - left, bottom - top


def _glyph_pause(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    bar = STROKE * unit * 1.25
    gap = bar * 0.9
    x = left + (w - (2 * bar + gap)) / 2
    for _ in range(2):
        d.rounded_rectangle(
            [x, top + h * 0.06, x + bar, top + h * 0.94], radius=bar * 0.32, fill=colour
        )
        x += bar + gap


def _glyph_health(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # Two lobes over a deep V. The lobes sit HIGH and the point runs the full
    # remaining height — a shallow heart turns into a cloud at 16 px.
    r = w * 0.265
    cy = top + h * 0.27
    d.ellipse([left + w * 0.02, cy - r, left + w * 0.02 + 2 * r, cy + r], fill=colour)
    d.ellipse(
        [left + w * 0.98 - 2 * r, cy - r, left + w * 0.98, cy + r], fill=colour
    )
    d.polygon(
        [
            (left + w * 0.02, cy),
            (left + w * 0.98, cy),
            (left + w * 0.5, top + h * 1.0),
        ],
        fill=colour,
    )


def _glyph_game(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # A d-pad cross: the most legible gaming shorthand at tray size.
    arm = STROKE * unit * 1.3
    cx, cy = left + w / 2, top + h / 2
    d.rounded_rectangle(
        [cx - arm / 2, top + h * 0.02, cx + arm / 2, top + h * 0.98],
        radius=arm * 0.3,
        fill=colour,
    )
    d.rounded_rectangle(
        [left + w * 0.02, cy - arm / 2, left + w * 0.98, cy + arm / 2],
        radius=arm * 0.3,
        fill=colour,
    )


def _glyph_movie(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    d.polygon(
        [
            (left + w * 0.14, top + h * 0.02),
            (left + w * 0.94, top + h * 0.5),
            (left + w * 0.14, top + h * 0.98),
        ],
        fill=colour,
    )


def _glyph_office(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # A briefcase: a chunky detached handle over a wide, low body.
    #
    # Two things fought each other here. Merged into the body, the handle reads
    # as a folder tab; and a body filling the whole glyph box is just a smaller
    # copy of the surface it is punched out of. So the body is deliberately
    # SHORT and wide, with real air above it.
    handle_w = w * 0.46
    bar = h * 0.17
    d.rounded_rectangle(
        [left + (w - handle_w) / 2, top, left + (w + handle_w) / 2, top + bar],
        radius=bar * 0.42,
        fill=colour,
    )
    d.rounded_rectangle(
        [left, top + bar * 1.75, left + w, top + h], radius=w * 0.09, fill=colour
    )


def _glyph_editing(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # A pencil pointing down-left: one thick diagonal shaft plus a tip triangle.
    # Drawn as a stroked line rather than a hand-built quad — the quad version
    # collapsed into an unreadable blob once the glyph box grew.
    shaft = STROKE * unit * 1.45
    tip_x, tip_y = left + w * 0.06, top + h * 0.94
    d.line(
        [
            (left + w * 0.30, top + h * 0.70),
            (left + w * 0.86, top + h * 0.14),
        ],
        fill=colour,
        width=round(shaft),
        joint="curve",
    )
    d.polygon(
        [
            (tip_x, tip_y),
            (left + w * 0.10, top + h * 0.56),
            (left + w * 0.44, top + h * 0.90),
        ],
        fill=colour,
    )


def _glyph_reading(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # An open book: two pages splayed from a centre gutter. Deliberately NOT a
    # 2x2 grid and NOT split by a straight vertical spine — that reads as the
    # Windows logo.
    gutter = STROKE * unit * 0.55
    for side in (-1, 1):
        inner = left + w / 2 + side * gutter / 2
        outer = left + w / 2 + side * (w / 2)
        d.polygon(
            [
                (inner, top + h * 0.12),
                (outer, top + h * 0.00),
                (outer, top + h * 0.80),
                (inner, top + h * 1.00),
            ],
            fill=colour,
        )


def _glyph_custom(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # Three slider tracks at staggered lengths — "tuned by hand".
    bar = STROKE * unit
    gap = (h - 3 * bar) / 2
    for i, frac in enumerate((1.0, 0.62, 0.84)):
        y = top + i * (bar + gap)
        d.rounded_rectangle(
            [left, y, left + w * frac, y + bar], radius=bar / 2, fill=colour
        )


MODE_GLYPHS = {
    "pause": _glyph_pause,
    "health": _glyph_health,
    "game": _glyph_game,
    "movie": _glyph_movie,
    "office": _glyph_office,
    "editing": _glyph_editing,
    "reading": _glyph_reading,
    "custom": _glyph_custom,
}
"""Mirrors `DISPLAY_MODE_IDS` in `src-tauri/src/settings/mod.rs`."""


# ── Rendering ───────────────────────────────────────────────────────────────


def _render_mark(unit: int, mode: str, style: MarkStyle) -> Image.Image:
    """Render the mark alone into a transparent `unit` x `unit` image.

    Note every "erase" below is an `ImageDraw` fill with alpha 0. ImageDraw
    REPLACES pixels rather than blending them, which is what lets the seam and
    the glyph be punched straight through the surface — no masks needed.
    """
    layer = Image.new("RGBA", (unit, unit), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    radius = SURFACE_RADIUS * unit

    # The whole silhouette is ONE rounded rectangle; the band is the same shape
    # clipped to its lower portion, so the outer outline stays a single clean
    # curve instead of two shapes that almost line up.
    d.rounded_rectangle([0, 0, unit - 1, unit - 1], radius=radius, fill=style.surface)

    band = Image.new("RGBA", (unit, unit), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bd.rounded_rectangle([0, 0, unit - 1, unit - 1], radius=radius, fill=style.band)
    bd.rectangle([0, 0, unit, BAND_TOP * unit], fill=(0, 0, 0, 0))
    layer.alpha_composite(band)

    # The seam: a transparent slot between the two planes.
    band_top = BAND_TOP * unit
    d.rectangle([0, band_top - SEAM * unit, unit, band_top], fill=(0, 0, 0, 0))

    # Knock the mode glyph out of the upper plane.
    gl, gt, gr, gb = GLYPH_BOX
    MODE_GLYPHS[mode](
        d, (gl * unit, gt * unit, gr * unit, gb * unit), (0, 0, 0, 0), unit
    )
    return layer


def render_tray(mode: str, phase: str, on_theme: str, size: int) -> Image.Image:
    """The TRAY icon: the bare mark on transparency, no tile.

    Only optical padding — every remaining pixel goes to the mark, which is the
    difference between a readable and an unreadable 16 px glyph.
    """
    n = size * SUPERSAMPLE
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    pad = round(n * 0.05)
    mark = _render_mark(n - 2 * pad, mode, mark_style(phase, on_theme))
    img.alpha_composite(mark, (pad, pad))
    return img.resize((size, size), Image.Resampling.LANCZOS)


def render_app(mode: str, phase: str, size: int) -> Image.Image:
    """The APP icon: the mark centred on the dark squircle tile.

    Installers, the taskbar button and the About panel want a full tile; the
    tray does not. `mode`/`phase` are parameters so the same code can render a
    variant sheet, but the shipped app icon is always the default pair.
    """
    n = size * SUPERSAMPLE
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    tile_pad = n * 0.055
    d.rounded_rectangle(
        [tile_pad, tile_pad, n - tile_pad, n - tile_pad], radius=n * 0.225, fill=TILE
    )
    unit = round(n * 0.58)
    mark = _render_mark(unit, mode, mark_style(phase, "dark"))
    img.alpha_composite(mark, ((n - unit) // 2, (n - unit) // 2))
    return img.resize((size, size), Image.Resampling.LANCZOS)


DEFAULT_APP_MODE = "health"
"""Mode drawn on the shipped app icon.

`health` is the app's own recommendation and its glyph (a heart) is the one that
reads best as a standalone brand mark — `pause` would put "switched off" on the
installer.
"""

DEFAULT_APP_PHASE = "night"
"""Phase drawn on the shipped app icon: the warm band is the app's whole point."""
