#!/usr/bin/env python3
"""Build the DimRead application and tray icon set.

The application icon is derived from ``dimread-icon-master.png``: the generated
"dimming horizon" brand mark.  It combines a cool light being occluded from the
bottom, a warm eye-comfort glow, and a bottom-edge brightness control.

Outputs:

  src-tauri/icons/          app + installer icons (tauri.conf bundle.icon)
    32x32.png 128x128.png 128x128@2x.png 512x512.png icon.ico icon.icns

  src-tauri/icons/          tray icons embedded by src/tray.rs (include_bytes!)
    tray-on-dark.png          compact full-color mark on a DARK taskbar
    tray-on-light.png         compact full-color mark on a LIGHT taskbar

Run: python tools/assets/generate-icons.py
 (or: uv run --with pillow tools/assets/generate-icons.py)
Idempotent; safe to re-run.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
ASSETS = Path(__file__).resolve().parent
ICONS = REPO / "src-tauri" / "icons"
SOURCE = ASSETS / "dimread-icon-master.png"

MASTER = 1024
TRAY_SIZE = 64
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def _square_crop_box(bbox: tuple[int, int, int, int], padding: float) -> tuple[int, int, int, int]:
	"""Return a centered square crop around an alpha bounding box."""
	left, top, right, bottom = bbox
	width = right - left
	height = bottom - top
	side = math.ceil(max(width, height) * (1 + 2 * padding))
	cx = (left + right) / 2
	cy = (top + bottom) / 2
	return (
		math.floor(cx - side / 2),
		math.floor(cy - side / 2),
		math.floor(cx - side / 2) + side,
		math.floor(cy - side / 2) + side,
	)


def build_master() -> Image.Image:
	"""Normalize the generated source to a transparent square master."""
	if not SOURCE.exists():
		raise FileNotFoundError(f"Missing icon source: {SOURCE}")

	source = Image.open(SOURCE).convert("RGBA")
	bbox = source.getchannel("A").getbbox()
	if bbox is None:
		raise ValueError(f"Icon source is fully transparent: {SOURCE}")

	# Keep a small optical margin around the rounded tile. Pillow pads with
	# transparent pixels when the crop extends beyond the source canvas.
	cropped = source.crop(_square_crop_box(bbox, padding=0.065))
	return cropped.resize((MASTER, MASTER), Image.Resampling.LANCZOS)


def build_tray(master: Image.Image) -> Image.Image:
	"""Use the complete app tile in the tray instead of a fragile cut-out glyph.

	The former monochrome adaptation separated the dimming dome from its slider.
	At Windows' small tray size that negative space looked like accidental clipping.
	The full tile has an opaque center and already includes its own optical padding,
	so it remains complete on both light and dark taskbars.
	"""
	return master.resize((TRAY_SIZE, TRAY_SIZE), Image.Resampling.LANCZOS)


def main() -> None:
	ICONS.mkdir(parents=True, exist_ok=True)
	master = build_master()
	written: list[str] = []

	def emit(img: Image.Image, name: str) -> None:
		img.save(ICONS / name)
		written.append(str(ICONS / name))

	emit(master.resize((32, 32), Image.Resampling.LANCZOS), "32x32.png")
	emit(master.resize((128, 128), Image.Resampling.LANCZOS), "128x128.png")
	emit(master.resize((256, 256), Image.Resampling.LANCZOS), "128x128@2x.png")
	emit(master.resize((512, 512), Image.Resampling.LANCZOS), "512x512.png")

	members = [master.resize((size, size), Image.Resampling.LANCZOS) for size in ICO_SIZES]
	ico_path = ICONS / "icon.ico"
	members[-1].save(
		ico_path,
		format="ICO",
		sizes=[(size, size) for size in ICO_SIZES],
		append_images=members[:-1],
	)
	written.append(str(ico_path))

	icns_path = ICONS / "icon.icns"
	master.save(icns_path, format="ICNS")
	written.append(str(icns_path))

	tray = build_tray(master)
	emit(tray, "tray-on-dark.png")
	emit(tray, "tray-on-light.png")

	print(f"{len(written)} icons written:")
	for path in written:
		print(f"  {path}")


if __name__ == "__main__":
	main()
