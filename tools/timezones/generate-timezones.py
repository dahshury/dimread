#!/usr/bin/env python3
"""Generate `src-tauri/src/display/timezones_data.rs` from the IANA tzdb.

DimRead derives the user's approximate location from their system timezone —
that is what makes "time based on location" work offline, with no location
permission prompt and no network call, and it is also what backs the manual
timezone picker. The mapping from an IANA zone id to a latitude/longitude is
published by the tz database itself in `zone.tab`, so it is generated here
rather than hand-maintained.

The coordinates are the zone's reference locality (the city the zone is named
after). For sun times that is accurate enough: sunrise moves ~4 minutes per
degree of longitude, and every zone's reference city is by construction the
place its civil clock is set for.

Two tables come out of this:

  * ZONES   — canonical zones with coordinates, from `zone.tab`. This is also
              what the manual timezone picker lists.
  * ALIASES — deprecated zone ids → their canonical name, from `backward`.
              Lookup-only, never listed. Needed because the Windows→IANA (CLDR)
              mapping still hands back aliases: an Indian machine reports
              `Asia/Calcutta`, which no longer appears in `zone.tab` at all.

Usage:
    python tools/timezones/generate-timezones.py              # download tzdb files
    python tools/timezones/generate-timezones.py --input-dir path/to/tzdb

Re-run after a tzdb release; `cargo test` fails if the generated tables are
empty, unsorted, or contain an alias that resolves nowhere.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import urllib.request

TZDB_RAW = "https://raw.githubusercontent.com/eggert/tz/main"
OUTPUT = (
    pathlib.Path(__file__).resolve().parents[2]
    / "src-tauri"
    / "src"
    / "display"
    / "timezones_data.rs"
)


def parse_iso6709(raw: str) -> tuple[float, float]:
    """Decode a zone.tab coordinate pair (`+DDMM+DDDMM` or `+DDMMSS+DDDMMSS`)."""
    if len(raw) == 11:
        lat_str, lon_str = raw[:5], raw[5:]
        lat_deg, lat_min, lat_sec = int(lat_str[1:3]), int(lat_str[3:5]), 0
        lon_deg, lon_min, lon_sec = int(lon_str[1:4]), int(lon_str[4:6]), 0
    elif len(raw) == 15:
        lat_str, lon_str = raw[:7], raw[7:]
        lat_deg, lat_min, lat_sec = int(lat_str[1:3]), int(lat_str[3:5]), int(lat_str[5:7])
        lon_deg, lon_min, lon_sec = int(lon_str[1:4]), int(lon_str[4:6]), int(lon_str[6:8])
    else:
        raise ValueError(f"unrecognised ISO 6709 coordinate: {raw!r}")

    latitude = lat_deg + lat_min / 60 + lat_sec / 3600
    longitude = lon_deg + lon_min / 60 + lon_sec / 3600
    if raw[0] == "-":
        latitude = -latitude
    if lon_str[0] == "-":
        longitude = -longitude
    return round(latitude, 4), round(longitude, 4)


def read_tzdb_file(name: str, input_dir: pathlib.Path | None) -> str:
    if input_dir is not None:
        return (input_dir / name).read_text(encoding="ascii")
    with urllib.request.urlopen(f"{TZDB_RAW}/{name}", timeout=60) as response:
        return response.read().decode("ascii")


def parse_zones(text: str) -> list[tuple[str, str, float, float]]:
    zones = []
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        country, coordinates, zone_id = fields[0], fields[1], fields[2]
        latitude, longitude = parse_iso6709(coordinates)
        zones.append((zone_id, country, latitude, longitude))
    return zones


def parse_aliases(text: str) -> list[tuple[str, str]]:
    """`Link<TAB>TARGET<TAB>ALIAS` rows, as (alias, target)."""
    aliases = []
    for line in text.splitlines():
        if not line.startswith("Link"):
            continue
        fields = [field for field in line.split("\t") if field]
        if len(fields) < 3:
            continue
        aliases.append((fields[2].split("#")[0].strip(), fields[1].strip()))
    return aliases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=pathlib.Path, default=None)
    args = parser.parse_args()

    zones = parse_zones(read_tzdb_file("zone.tab", args.input_dir))
    if len(zones) < 300:
        print(f"zone.tab yielded only {len(zones)} zones — refusing to write", file=sys.stderr)
        return 1

    known = {zone_id for zone_id, _, _, _ in zones}
    aliases = [
        (alias, target)
        for alias, target in parse_aliases(read_tzdb_file("backward", args.input_dir))
        # A handful of links point at other links (or at zones zone.tab omits).
        # Those cannot be resolved to coordinates, so they are dropped rather
        # than emitted as a dangling entry the Rust side would have to tolerate.
        if target in known and alias not in known
    ]
    if len(aliases) < 100:
        print(f"backward yielded only {len(aliases)} aliases — refusing to write", file=sys.stderr)
        return 1

    # Sorted so both tables can be binary-searched, and so regenerating never
    # churns the diff on an unrelated tzdb reordering.
    zones.sort(key=lambda row: row[0])
    aliases.sort(key=lambda row: row[0])

    zone_rows = "\n".join(
        f'    zone("{zone_id}", "{country}", {latitude:.4f}, {longitude:.4f}),'
        for zone_id, country, latitude, longitude in zones
    )
    alias_rows = "\n".join(f'    ("{alias}", "{target}"),' for alias, target in aliases)

    OUTPUT.write_text(
        "//! GENERATED by `tools/timezones/generate-timezones.py` from the IANA\n"
        "//! tzdb (`zone.tab` + `backward`). DO NOT EDIT — re-run the generator.\n"
        "//!\n"
        "//! Each [`ZONES`] entry is a timezone's reference locality, which is what\n"
        "//! DimRead uses to turn \"the system says I am in Europe/Berlin\" into sun\n"
        "//! times. [`ALIASES`] maps the deprecated ids platforms still report\n"
        "//! (Windows says `Asia/Calcutta`) onto their canonical zone. Both are\n"
        "//! sorted by key so [`super::timezones::lookup`] can binary-search.\n"
        "\n"
        "use super::timezones::TimeZoneLocation;\n"
        "\n"
        "const fn zone(\n"
        "    id: &'static str,\n"
        "    country: &'static str,\n"
        "    latitude: f64,\n"
        "    longitude: f64,\n"
        ") -> TimeZoneLocation {\n"
        "    TimeZoneLocation {\n"
        "        id,\n"
        "        country,\n"
        "        latitude,\n"
        "        longitude,\n"
        "    }\n"
        "}\n"
        "\n"
        f"pub(super) static ZONES: [TimeZoneLocation; {len(zones)}] = [\n{zone_rows}\n];\n"
        "\n"
        "/// `(deprecated id, canonical id)`.\n"
        f"pub(super) static ALIASES: [(&str, &str); {len(aliases)}] = [\n{alias_rows}\n];\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {len(zones)} zones and {len(aliases)} aliases to {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
