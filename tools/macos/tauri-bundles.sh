#!/usr/bin/env bash
# Build the macOS bundles (.app + .dmg) for one architecture and collect them
# in dist/macos/<arch> with arch-suffixed filenames.
#
#   tools/macos/tauri-bundles.sh aarch64-apple-darwin aarch64
#   tools/macos/tauri-bundles.sh x86_64-apple-darwin x86_64
#
# TAURI_BUNDLE_CONFIG overrides the config overlay (default: the CI overlay
# that disables updater artifacts so no signing key is needed). Pass "none"
# to build with the base tauri.conf.json only.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <rust-target> <artifact-arch>" >&2
  exit 2
fi

target="$1"
arch="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
output_dir="$repo_root/dist/macos/$arch"
bundle_dir="$repo_root/src-tauri/target/$target/release/bundle"
config="${TAURI_BUNDLE_CONFIG:-$repo_root/tools/tauri-ci-artifacts.conf.json}"

cd "$repo_root"

build_args=(--target "$target" --bundles app,dmg)
if [ "$config" != "none" ]; then
  build_args+=(--config "$config")
fi

# Clear previous bundle output so stale artifacts can never be collected.
rm -rf "$bundle_dir/macos" "$bundle_dir/dmg"
bun run tauri build "${build_args[@]}"

# Unsigned builds disable Tauri updater artifacts, so create the portable app
# archive explicitly — it is still useful to publish and audit.
app_bundle="$(find "$bundle_dir/macos" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [ -z "$app_bundle" ]; then
  echo "No macOS app bundle was produced for $target." >&2
  exit 1
fi
app_archive="$bundle_dir/macos/$(basename "${app_bundle%.app}").app.tar.gz"
tar -czf "$app_archive" -C "$(dirname "$app_bundle")" "$(basename "$app_bundle")"

rm -rf "$output_dir"
mkdir -p "$output_dir"

copy_artifact() {
  local artifact="$1"
  local name
  local dest
  name="$(basename "$artifact")"

  case "$name" in
    *"$arch"*)
      dest="$name"
      ;;
    *.app.tar.gz.sig)
      dest="${name%.app.tar.gz.sig}-$arch.app.tar.gz.sig"
      ;;
    *.app.tar.gz)
      dest="${name%.app.tar.gz}-$arch.app.tar.gz"
      ;;
    *.dmg)
      dest="${name%.dmg}-$arch.dmg"
      ;;
    *)
      dest="$name"
      ;;
  esac

  cp "$artifact" "$output_dir/$dest"
}

artifact_count=0
while IFS= read -r artifact; do
  copy_artifact "$artifact"
  artifact_count=$((artifact_count + 1))
done < <(
  find "$bundle_dir" -type f \
    \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.app.tar.gz.sig' \) |
    sort
)

if [ "$artifact_count" -eq 0 ]; then
  echo "No macOS bundle artifacts were produced for $target." >&2
  exit 1
fi

printf 'macOS artifacts written to %s:\n' "$output_dir"
find "$output_dir" -maxdepth 1 -type f -print | sort | sed 's#^#  #'
