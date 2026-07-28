#!/usr/bin/env python3
r"""The DimRead temperature-disc brand mark, drawn procedurally.

ONE geometry is rendered into every icon the app ships. The mark is a circle
split through its centre: brand indigo is the constant cool/identity half and
the emitted day/night light is the warm/state half. The active mode glyph is
knocked through the whole disc and straddles the split.

The tray uses the bare disc on transparency. The app icon keeps the dark
squircle tile behind it. Everything is normalised 0..1 over the disc's own box
and supersampled before the final resize so the same drawing serves 16 px tray
icons and the 1024 px app-icon master.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from PIL import Image, ImageChops, ImageDraw

# Pillow has no anti-aliased vector rasteriser. Drawing at 8x and reducing with
# LANCZOS is enough to keep the 16 px circle and diagonal glyphs clean.
SUPERSAMPLE = 8

# Both split geometries are intentionally kept live so the design choice can be
# checked in tools/assets/icon-preview/split-comparison.png.
SPLIT_MODES = ("vertical", "diagonal")
SPLIT_MODE = "diagonal"
"""Active disc split: vertical or diagonal.

The diagonal is about 30 degrees through the centre, with the state/warm half
on the lower-right. Change only this constant to ship the vertical alternative.
"""

SPLIT_ANGLE_DEGREES = 30.0

# ── Palette ─────────────────────────────────────────────────────────────────
# surface remains the identity/cool half and band remains the emitted
# light/state half in MarkStyle so the existing public API stays stable.

SURFACE_ON_DARK = (108, 124, 255, 255)
SURFACE_ON_LIGHT = (43, 51, 110, 255)

BAND_DAY_ON_DARK = (186, 208, 255, 255)
# More cyan and materially lighter than the identity indigo. This is selected
# for separation on a light taskbar, where the old #6084E0 band looked muddy.
BAND_DAY_ON_LIGHT = (70, 151, 218, 255)
BAND_NIGHT_ON_DARK = (250, 176, 78, 255)
BAND_NIGHT_ON_LIGHT = (214, 130, 26, 255)

TILE = (14, 17, 32, 255)

# ── Geometry (normalised 0..1 over the disc) ────────────────────────────────

TRAY_PAD = 0.02
"""Optical tray padding: the circular silhouette occupies 96% of the box."""

GLYPH_BOX = (0.22, 0.22, 0.78, 0.78)
"""Centred 56%-diameter square used as the default glyph layout box."""

GLYPH_CONTAINMENT_RADIUS = 0.40
"""Maximum glyph radius as a fraction of disc diameter.

This preserves a continuous ring at least 0.10D thick around every knockout.
"""

STROKE = 0.14
"""Minimum feature weight as a fraction of disc diameter (~2.2 px at 16 px)."""


@dataclass(frozen=True)
class MarkStyle:
    surface: tuple[int, int, int, int]
    band: tuple[int, int, int, int]


def mark_style(phase: str, on_theme: str) -> MarkStyle:
    """Resolve the (day|night) x (dark|light taskbar) colour pair."""
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
# Glyph functions draw into a one-channel knockout mask. White removes the disc
# and black preserves it. Every completed mask is asserted to fit inside the
# global 0.40D containment circle before it can be applied to the mark.


def _span(box: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    left, top, right, bottom = box
    return left, top, right - left, bottom - top


def _glyph_pause(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    bar = STROKE * unit
    gap = STROKE * unit * 0.86
    x = left + (w - (2 * bar + gap)) / 2
    for _ in range(2):
        d.rounded_rectangle(
            [x, top + h * 0.03, x + bar, top + h * 0.97],
            radius=bar * 0.28,
            fill=colour,
        )
        x += bar + gap


def _glyph_health(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # High lobes and a deep point keep the heart distinct from a cloud at 16 px.
    radius = w * 0.265
    centre_y = top + h * 0.28
    d.ellipse(
        [left + w * 0.02, centre_y - radius, left + w * 0.02 + 2 * radius, centre_y + radius],
        fill=colour,
    )
    d.ellipse(
        [left + w * 0.98 - 2 * radius, centre_y - radius, left + w * 0.98, centre_y + radius],
        fill=colour,
    )
    d.polygon(
        [
            (left + w * 0.02, centre_y),
            (left + w * 0.98, centre_y),
            (left + w * 0.5, top + h),
        ],
        fill=colour,
    )


def _glyph_game(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    # The neck keeps the 0.14D minimum weight; slightly wider terminal caps make
    # this a controller d-pad rather than a medical cross.
    neck = STROKE * unit
    cap = STROKE * unit * 1.42
    cap_depth = STROKE * unit * 1.12
    cx, cy = left + w / 2, top + h / 2
    d.rounded_rectangle(
        [cx - neck / 2, top, cx + neck / 2, top + h],
        radius=neck * 0.18,
        fill=colour,
    )
    d.rounded_rectangle(
        [left, cy - neck / 2, left + w, cy + neck / 2],
        radius=neck * 0.18,
        fill=colour,
    )
    d.rounded_rectangle(
        [cx - cap / 2, top, cx + cap / 2, top + cap_depth],
        radius=neck * 0.2,
        fill=colour,
    )
    d.rounded_rectangle(
        [cx - cap / 2, top + h - cap_depth, cx + cap / 2, top + h],
        radius=neck * 0.2,
        fill=colour,
    )
    d.rounded_rectangle(
        [left, cy - cap / 2, left + cap_depth, cy + cap / 2],
        radius=neck * 0.2,
        fill=colour,
    )
    d.rounded_rectangle(
        [left + w - cap_depth, cy - cap / 2, left + w, cy + cap / 2],
        radius=neck * 0.2,
        fill=colour,
    )


def _glyph_movie(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    left, top, w, h = _span(box)
    d.polygon(
        [
            (left + w * 0.12, top),
            (left + w * 0.96, top + h * 0.5),
            (left + w * 0.12, top + h),
        ],
        fill=colour,
    )


def _glyph_office(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    del box
    # A briefcase: a wide body with a DETACHED handle floating above it.
    #
    # This glyph was the hardest of the eight, because every solid-block variant
    # lands within 0.05 of some other mode at 16 px — measured: a portrait page
    # collides with `pause` and `movie`, a landscape page collides with
    # `reading`. What finally separates it is topology rather than proportion:
    # nothing else in the roster is TWO shapes with a gap between them, so the
    # gap is the recognition cue and it is the one cue no other glyph can fake.
    #
    # The gap is 0.085D (~1.2 px at tray size) — the smallest feature anywhere
    # in the roster, and load-bearing. Do not close it up.
    handle_h = STROKE * unit
    d.rounded_rectangle(
        [0.405 * unit, 0.270 * unit, 0.595 * unit, 0.270 * unit + handle_h],
        radius=handle_h * 0.34,
        fill=colour,
    )
    d.rounded_rectangle(
        [0.245 * unit, 0.495 * unit, 0.755 * unit, 0.755 * unit],
        radius=0.05 * unit,
        fill=colour,
    )


def _glyph_editing(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    del box
    # A pencil, as a kite along the 45-degree axis: sharp tip at the lower-left,
    # widening to a 0.17D shaft, closing on a flat tail cut square across the
    # axis. LONG and NARROW on purpose — a short fat wedge is a triangular mass
    # and collides with `movie`'s play triangle at 16 px (measured: 0.031). A
    # constant-thickness bar, on the other hand, reads as a prohibition slash.
    # Long + tapered + flat-tailed is the only combination that is neither.
    d.polygon(
        [
            (0.252 * unit, 0.748 * unit),
            (0.286 * unit, 0.594 * unit),
            (0.594 * unit, 0.286 * unit),
            (0.714 * unit, 0.406 * unit),
            (0.406 * unit, 0.714 * unit),
        ],
        fill=colour,
    )


def _glyph_reading(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    del box
    # A bookmark: one upright block with a V notch cut into the BOTTOM.
    #
    # Three open-book variants were built and rejected by looking at the 16 px
    # cells. Two pages either side of a gutter is the same topology as `pause`
    # — two vertical masses separated by a vertical gap — and no amount of
    # tilting the pages survives downsampling, so the two modes became
    # interchangeable. A solid block with a notch in the TOP reads as a bucket.
    #
    # A bottom notch is the one cue nothing else in the roster has, it says
    # "bookmark" rather than "gate", and being a single mass is exactly what
    # separates it from `pause`.
    left, right = 0.345 * unit, 0.655 * unit
    top, bottom = 0.235 * unit, 0.765 * unit
    d.polygon(
        [
            (left, top),
            (right, top),
            (right, bottom),
            (0.50 * unit, 0.630 * unit),
            (left, bottom),
        ],
        fill=colour,
    )


def _glyph_custom(d: ImageDraw.ImageDraw, box, colour, unit: float) -> None:
    del box
    # An equalizer: three bars on a common baseline at three different heights.
    #
    # Two rejected predecessors, both killed at 16 px: three stacked HORIZONTAL
    # bars became a barcode, and a track-plus-handle slider read as an arrowhead
    # whichever side the handle sat on (measured against `movie`: 0.027).
    #
    # What works is the staggered SKYLINE. Nothing else in the roster has an
    # uneven top edge over a flat base, and unlike a slider handle the cue is
    # spread across the whole glyph rather than concentrated in one 2 px block.
    # It is also the most honest picture of what this mode is: levels set by hand.
    bar = STROKE * unit
    gap = 0.07 * unit
    baseline = 0.735 * unit
    for i, top in enumerate((0.435, 0.235, 0.345)):
        x = 0.22 * unit + i * (bar + gap)
        d.rounded_rectangle(
            [x, top * unit, x + bar, baseline], radius=bar * 0.30, fill=colour
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
"""Mirrors DISPLAY_MODE_IDS in src-tauri/src/settings/mod.rs."""


# ── Rendering ───────────────────────────────────────────────────────────────


def _split_mask(unit: int, split_mode: str) -> Image.Image:
    if split_mode not in SPLIT_MODES:
        raise ValueError(
            f"split_mode must be one of {SPLIT_MODES!r}, got {split_mode!r}"
        )

    mask = Image.new("L", (unit, unit), 0)
    d = ImageDraw.Draw(mask)
    centre = unit / 2
    if split_mode == "vertical":
        d.rectangle([centre, 0, unit, unit], fill=255)
        return mask

    angle = math.radians(SPLIT_ANGLE_DEGREES)
    # In image coordinates this line rises toward the upper-right. Its normal
    # points down/right, selecting the warm lower-right half-plane.
    direction = (math.cos(angle), -math.sin(angle))
    warm_normal = (math.sin(angle), math.cos(angle))
    reach = unit * 2
    line_a = (
        centre - direction[0] * reach,
        centre - direction[1] * reach,
    )
    line_b = (
        centre + direction[0] * reach,
        centre + direction[1] * reach,
    )
    d.polygon(
        [
            line_a,
            line_b,
            (
                line_b[0] + warm_normal[0] * reach,
                line_b[1] + warm_normal[1] * reach,
            ),
            (
                line_a[0] + warm_normal[0] * reach,
                line_a[1] + warm_normal[1] * reach,
            ),
        ],
        fill=255,
    )
    return mask


def _render_mark(
    unit: int, mode: str, style: MarkStyle, split_mode: str = SPLIT_MODE
) -> Image.Image:
    """Render one temperature disc into a transparent square."""
    if mode not in MODE_GLYPHS:
        raise ValueError(f"unknown mode {mode!r}")

    disc_box = [0, 0, unit - 1, unit - 1]
    layer = Image.new("RGBA", (unit, unit), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(disc_box, fill=style.surface)

    warm = Image.new("RGBA", (unit, unit), (0, 0, 0, 0))
    ImageDraw.Draw(warm).ellipse(disc_box, fill=style.band)
    warm.putalpha(ImageChops.multiply(warm.getchannel("A"), _split_mask(unit, split_mode)))
    layer.alpha_composite(warm)

    knockout = Image.new("L", (unit, unit), 0)
    glyph_draw = ImageDraw.Draw(knockout)
    gl, gt, gr, gb = GLYPH_BOX
    MODE_GLYPHS[mode](
        glyph_draw,
        (gl * unit, gt * unit, gr * unit, gb * unit),
        255,
        unit,
    )

    centre = unit / 2
    radius = GLYPH_CONTAINMENT_RADIUS * unit
    containment = Image.new("L", (unit, unit), 0)
    ImageDraw.Draw(containment).ellipse(
        [centre - radius, centre - radius, centre + radius, centre + radius],
        fill=255,
    )
    outside = ImageChops.subtract(knockout, containment)
    assert outside.getbbox() is None, (
        f"{mode} glyph exceeds the centred {GLYPH_CONTAINMENT_RADIUS:.2f}D "
        "containment radius"
    )
    knockout = ImageChops.multiply(knockout, containment)

    layer.putalpha(ImageChops.subtract(layer.getchannel("A"), knockout))
    return layer


def _render_tray_for_split(
    mode: str, phase: str, on_theme: str, size: int, split_mode: str
) -> Image.Image:
    """Internal tray renderer used to exercise both split candidates."""
    n = size * SUPERSAMPLE
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    pad = round(n * TRAY_PAD)
    mark = _render_mark(
        n - 2 * pad,
        mode,
        mark_style(phase, on_theme),
        split_mode=split_mode,
    )
    img.alpha_composite(mark, (pad, pad))
    return img.resize((size, size), Image.Resampling.LANCZOS)


def render_tray(mode: str, phase: str, on_theme: str, size: int) -> Image.Image:
    """Render the bare temperature disc for a tray icon."""
    return _render_tray_for_split(mode, phase, on_theme, size, SPLIT_MODE)


def render_app(mode: str, phase: str, size: int) -> Image.Image:
    """Render the temperature disc centred on the app icon's dark squircle."""
    n = size * SUPERSAMPLE
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    tile_pad = n * 0.055
    d.rounded_rectangle(
        [tile_pad, tile_pad, n - tile_pad, n - tile_pad],
        radius=n * 0.225,
        fill=TILE,
    )
    unit = round(n * 0.64)
    mark = _render_mark(unit, mode, mark_style(phase, "dark"))
    img.alpha_composite(mark, ((n - unit) // 2, (n - unit) // 2))
    return img.resize((size, size), Image.Resampling.LANCZOS)


DEFAULT_APP_MODE = "health"
"""Mode drawn on the shipped app icon."""

DEFAULT_APP_PHASE = "night"
"""Phase drawn on the shipped app icon."""
