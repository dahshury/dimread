"""Procedural source for DimRead's app and tray mark: "the Dial".

The mark is one invariant circular silhouette divided by straight, full-width
seams into two flat colour roles.  The body carries identity; the accent shows
the light DimRead is emitting.  Display mode changes only the accent region's
topology and orientation, phase changes only its hue, and taskbar theme selects
a wholly light or wholly dark palette.  Keeping those concerns independent
makes all 32 tray states remain one closed shape when Windows downsamples the
single 64 px asset to taskbar sizes as small as 16 px.

There are deliberately no strokes, gradients, shadows, badges, glyphs, or
interior details.  The same fat-feature geometry is used for app and tray icons
at every requested size, with supersampling providing the only antialiasing.
"""

from __future__ import annotations

from typing import Final, TypedDict

from PIL import Image, ImageChops, ImageDraw

__all__ = [
    "DEFAULT_APP_MODE",
    "DEFAULT_APP_PHASE",
    "MODE_GLYPHS",
    "SPLIT_MODE",
    "SPLIT_MODES",
    "_render_tray_for_split",
    "mark_style",
    "render_app",
    "render_tray",
]


class ModeSpec(TypedDict):
    """Topology of a mode's accent region."""

    seams: int
    axis: str
    accent_side: str


class MarkStyle(TypedDict):
    """The two flat colours used by a rendered mark."""

    body: str
    accent: str


MODE_GLYPHS: Final[dict[str, ModeSpec]] = {
    "pause": {"seams": 0, "axis": "none", "accent_side": "whole"},
    "health": {"seams": 1, "axis": "horizontal", "accent_side": "bottom"},
    "game": {"seams": 2, "axis": "vertical", "accent_side": "band"},
    "movie": {"seams": 1, "axis": "vertical", "accent_side": "left"},
    "office": {"seams": 2, "axis": "horizontal", "accent_side": "band"},
    "editing": {"seams": 1, "axis": "vertical", "accent_side": "right"},
    "reading": {"seams": 1, "axis": "horizontal", "accent_side": "top"},
    "custom": {"seams": 2, "axis": "diagonal", "accent_side": "band"},
}

SPLIT_MODE: Final = "straight"
SPLIT_MODES: Final = ("straight", "wide", "offset")
DEFAULT_APP_MODE: Final = "reading"
DEFAULT_APP_PHASE: Final = "night"

_DISC_MIN: Final = 0.04
_DISC_MAX: Final = 0.96
_DISC_DIAMETER: Final = _DISC_MAX - _DISC_MIN
_SPLIT_PARAMETERS: Final[dict[str, tuple[float, float]]] = {
    "straight": (0.00, 0.40),
    "wide": (0.00, 0.52),
    "offset": (0.08, 0.40),
}
_TRAY_PALETTES: Final = {
    "dark": {
        "body": "#9B8CF2",
        "day": "#7FE6FF",
        "night": "#FFCE85",
    },
    "light": {
        "body": "#5B4FA8",
        "day": "#0E7C84",
        "night": "#A85800",
    },
}
_APP_PALETTE: Final = {
    "body": "#8B7BEE",
    "day": "#9FE9FF",
    "night": "#FFB84F",
}


def mark_style(phase: str, on_theme: str) -> MarkStyle:
    """Return the fixed two-colour tray palette for a phase and taskbar theme."""
    if phase not in ("day", "night"):
        raise ValueError(f"unknown phase: {phase!r}")
    if on_theme not in _TRAY_PALETTES:
        raise ValueError(f"unknown taskbar theme: {on_theme!r}")

    palette = _TRAY_PALETTES[on_theme]
    return {"body": palette["body"], "accent": palette[phase]}


def _validate_render_inputs(mode: str, phase: str, size: int) -> None:
    if mode not in MODE_GLYPHS:
        raise ValueError(f"unknown display mode: {mode!r}")
    if phase not in ("day", "night"):
        raise ValueError(f"unknown phase: {phase!r}")
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise ValueError(f"size must be a positive integer, got {size!r}")


def _draw_one_seam_region(
    draw: ImageDraw.ImageDraw,
    spec: ModeSpec,
    canvas: float,
    seam_offset: float,
) -> None:
    shift = seam_offset * _DISC_DIAMETER * canvas
    centre = 0.5 * canvas
    side = spec["accent_side"]

    if side == "bottom":
        draw.rectangle((0, centre - shift, canvas, canvas), fill=255)
    elif side == "top":
        draw.rectangle((0, 0, canvas, centre + shift), fill=255)
    elif side == "left":
        draw.rectangle((0, 0, centre + shift, canvas), fill=255)
    elif side == "right":
        draw.rectangle((centre - shift, 0, canvas, canvas), fill=255)
    else:
        raise ValueError(f"invalid one-seam accent side: {side!r}")


def _draw_band_region(
    draw: ImageDraw.ImageDraw,
    spec: ModeSpec,
    canvas: float,
    band_frac: float,
) -> None:
    half_width = band_frac * _DISC_DIAMETER * canvas / 2
    centre = 0.5 * canvas
    axis = spec["axis"]

    if axis == "vertical":
        draw.rectangle(
            (centre - half_width, 0, centre + half_width, canvas), fill=255
        )
    elif axis == "horizontal":
        draw.rectangle(
            (0, centre - half_width, canvas, centre + half_width), fill=255
        )
    elif axis == "diagonal":
        # Long axis (1, -1) makes a lower-left to upper-right "/" band.
        normal_offset = half_width / 2**0.5
        reach = canvas
        draw.polygon(
            (
                (centre - reach - normal_offset, centre + reach - normal_offset),
                (centre - reach + normal_offset, centre + reach + normal_offset),
                (centre + reach + normal_offset, centre - reach + normal_offset),
                (centre + reach - normal_offset, centre - reach - normal_offset),
            ),
            fill=255,
        )
    else:
        raise ValueError(f"invalid band axis: {axis!r}")


def _render_mark(
    mode: str,
    phase: str,
    size: int,
    style: MarkStyle,
    split_mode: str,
) -> Image.Image:
    _validate_render_inputs(mode, phase, size)
    if split_mode not in _SPLIT_PARAMETERS:
        raise ValueError(f"unknown split mode: {split_mode!r}")

    supersampling = max(1, min(8, 4096 // size))
    working_size = size * supersampling
    canvas = float(working_size)

    disc_mask = Image.new("L", (working_size, working_size), 0)
    ImageDraw.Draw(disc_mask).ellipse(
        (
            _DISC_MIN * canvas,
            _DISC_MIN * canvas,
            _DISC_MAX * canvas,
            _DISC_MAX * canvas,
        ),
        fill=255,
    )

    region_mask = Image.new("L", (working_size, working_size), 0)
    region_draw = ImageDraw.Draw(region_mask)
    spec = MODE_GLYPHS[mode]
    seam_offset, band_frac = _SPLIT_PARAMETERS[split_mode]
    if spec["seams"] == 0:
        region_draw.rectangle((0, 0, canvas, canvas), fill=255)
    elif spec["seams"] == 1:
        _draw_one_seam_region(region_draw, spec, canvas, seam_offset)
    else:
        _draw_band_region(region_draw, spec, canvas, band_frac)

    region_mask = ImageChops.multiply(region_mask, disc_mask)
    output = Image.new("RGBA", (working_size, working_size), (0, 0, 0, 0))
    output.paste(style["body"], mask=disc_mask)
    output.paste(style["accent"], mask=region_mask)
    return output.resize((size, size), Image.Resampling.LANCZOS)


def _render_tray_for_split(
    mode: str,
    phase: str,
    on_theme: str,
    size: int,
    split_mode: str,
) -> Image.Image:
    """Render one tray state with an explicit comparison split variant."""
    return _render_mark(mode, phase, size, mark_style(phase, on_theme), split_mode)


def render_tray(mode: str, phase: str, on_theme: str, size: int) -> Image.Image:
    """Render one shipped tray state using the default split geometry."""
    return _render_tray_for_split(mode, phase, on_theme, size, SPLIT_MODE)


def render_app(mode: str, phase: str, size: int) -> Image.Image:
    """Render an app icon using the same Dial geometry as the tray mark."""
    _validate_render_inputs(mode, phase, size)
    style: MarkStyle = {"body": _APP_PALETTE["body"], "accent": _APP_PALETTE[phase]}
    return _render_mark(mode, phase, size, style, SPLIT_MODE)
