#!/usr/bin/env bash
# Build Windows MSI installer for omp-windows-x64.exe using msitools/wixl.
# Runs on ubuntu-22.04 in CI; requires `apt-get install -y msitools`.
#
# Usage: bash scripts/ci-build-msi.sh <version> <binary-path> <output-path>
#   version      e.g. "16.3.10" (without leading 'v')
#   binary-path  path to omp-windows-x64.exe
#   output-path  path for the output .msi file

set -euo pipefail

VERSION="${1:?missing version}"
BINARY="${2:?missing binary path}"
OUTPUT="${3:?missing output path}"

# WiX expects a version of the form major.minor.build (max 255.255.65535).
# Strip any pre-release suffix and clamp to three components.
CLEAN_VERSION=$(echo "$VERSION" | sed 's/-.*//')
IFS='.' read -ra PARTS <<< "$CLEAN_VERSION"
MAJOR="${PARTS[0]:-0}"
MINOR="${PARTS[1]:-0}"
# WiX build field is max 65535
BUILD="${PARTS[2]:-0}"
if [ "$BUILD" -gt 65535 ] 2>/dev/null; then
	BUILD=65535
fi
WIX_VERSION="${MAJOR}.${MINOR}.${BUILD}"

# Generate stable UpgradeCode from the product name (UUID v5-style, dns namespace).
# This is deterministic so every build of the same product shares the upgrade code.
UPGRADE_CODE="D7B0F8A3-4E2C-5D1F-9A6E-8B3C7F2D1A5E"

BINARY_NAME="omp.exe"
BINARY_DIR=$(dirname "$BINARY")
BINARY_FILE=$(basename "$BINARY")

WXS_FILE=$(mktemp /tmp/omp-installer-XXXXXX.wxs)
trap 'rm -f "$WXS_FILE"' EXIT

cat > "$WXS_FILE" << WIXEOF
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product
    Id="*"
    Name="OMP Coding Agent"
    Manufacturer="oh-my-pi"
    UpgradeCode="${UPGRADE_CODE}"
    Language="1033"
    Codepage="1252"
    Version="${WIX_VERSION}">

    <Package
      Id="*"
      Keywords="Installer"
      Description="OMP Coding Agent Installer"
      Comments="oh-my-pi Windows installer"
      Manufacturer="oh-my-pi"
      InstallerVersion="200"
      Languages="1033"
      Compressed="yes"
      SummaryCodepage="1252"
      InstallScope="perUser" />

    <Media Id="1" Cabinet="omp.cab" EmbedCab="yes" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="APPLICATIONFOLDER" Name="omp">
          <Component Id="MainExecutable" Guid="*">
            <File
              Id="omp.exe"
              Name="${BINARY_NAME}"
              Source="${BINARY_DIR}/${BINARY_FILE}"
              KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="Complete" Title="OMP" Level="1" Display="expand"
             Description="OMP Coding Agent" ConfigurableDirectory="APPLICATIONFOLDER">
      <ComponentRef Id="MainExecutable" />
    </Feature>

    <!-- Register with Add/Remove Programs -->
    <Property Id="ARPCONTACT" Value="https://github.com/lukeliao/oh-my-pi" />
    <Property Id="ARPURLINFOABOUT" Value="https://github.com/lukeliao/oh-my-pi" />

    <UI>
      <UIRef Id="WixUI_Minimal" />
    </UI>

  </Product>
</Wix>
WIXEOF

echo "Generated WiX source: $WXS_FILE"
echo "Version: $WIX_VERSION (original: $VERSION)"
echo "Binary: $BINARY_DIR/$BINARY_FILE"
echo "Output: $OUTPUT"

wixl --output "$OUTPUT" "$WXS_FILE"

echo "MSI built: $OUTPUT ($(stat --format=%s "$OUTPUT") bytes)"
