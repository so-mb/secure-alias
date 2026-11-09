#!/bin/sh
set -eu

# This script downloads the official gPAS configuration archive, verifies its checksum,
# and extracts it into .local/gpas. Skips an existing extracted distribution.

# Run from the project root after reviewing the official download terms:
# https://www.ths-greifswald.de/nutzungsbedingungen/

gpas_dir=".local/gpas"
archive=".local/gpas-2026.1.1.zip"
target="$gpas_dir/compose-image-mariadb"

if [ -d "$target" ]; then
  echo "Distribution already present; preserving existing files."
  exit 0
fi

mkdir -p "$gpas_dir"

curl -fSL --connect-timeout 10 --max-time 60 \
  https://file.ths-greifswald.de/releases/gpas/2026.1.1/compose-image-gpas-mariadb-2026.1.1.zip \
  -o "$archive"
echo "318e6fec28df132797fd9b5c5235c515d2d18e00e927fb1cd05bff6711c3e559  $archive" | shasum -a 256 -c -

unzip -q "$archive" -d "$gpas_dir"
