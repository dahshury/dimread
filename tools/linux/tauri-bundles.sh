#!/usr/bin/env bash
# Build the Linux bundles (AppImage + deb + rpm) and collect them in dist/linux.
#
# TAURI_BUNDLE_CONFIG overrides the config overlay (default: the CI overlay
# that disables updater artifacts so no signing key is needed). Pass "none"
# to build with the base tauri.conf.json only.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
config="${TAURI_BUNDLE_CONFIG:-$repo_root/tools/tauri-ci-artifacts.conf.json}"
output_dir="$repo_root/dist/linux"
bundle_dir="$repo_root/src-tauri/target/release/bundle"

cd "$repo_root"

# AppImage tooling needs FUSE; extract-and-run works everywhere (incl. CI containers).
export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"

build_args=(--bundles appimage,deb,rpm)
if [ "$config" != "none" ]; then
  build_args+=(--config "$config")
fi

# Clear previous bundle output so stale artifacts can never be collected.
rm -rf "$bundle_dir/appimage" "$bundle_dir/deb" "$bundle_dir/rpm"

bun run tauri build "${build_args[@]}"

rm -rf "$output_dir"
mkdir -p "$output_dir"

mapfile -d '' artifacts < <(
  find "$bundle_dir" -type f \
    \( -name '*.AppImage' -o -name '*.AppImage.sig' -o -name '*.deb' -o -name '*.rpm' \) \
    -print0
)

if [ "${#artifacts[@]}" -eq 0 ]; then
  echo "No Linux bundle artifacts were produced." >&2
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  cp "$artifact" "$output_dir/"
done

printf 'Linux artifacts written to %s:\n' "$output_dir"
find "$output_dir" -maxdepth 1 -type f -printf '  %f\n' | sort
