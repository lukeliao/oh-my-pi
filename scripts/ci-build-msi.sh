#!/usr/bin/env bash
# Build the custom Windows MSI installer for our omp distribution.
#
# Layout installed (per-user, no admin required):
#   %LOCALAPPDATA%\omp\omp.exe                  fork cross-compiled exe (bun-windows-x64-baseline)
#   %LOCALAPPDATA%\omp\semble_rs.exe            semble_rs helper (cargo x86_64-pc-windows-gnu)
#   %LOCALAPPDATA%\omp\models\potion-code-16M\  Model2Vec model (portable files)
#   %LOCALAPPDATA%\omp\agent\tools\semble-rs\   8 semble_* xdev tools
#   %LOCALAPPDATA%\omp\agent\skills\*           bundled agent skills
#   HKCU\Environment                            PATH += install dir;
#                                               SEMBLE_RS_BIN; SEMBLE_MODEL_PATH;
#                                               PI_CODING_AGENT_DIR = <install dir>\agent
#
# Everything lives under one per-user root (%LOCALAPPDATA%\omp). The agent dir
# is NOT placed under %USERPROFILE%\.omp: MSI ProfileFolder resolves to the
# shell ProfilesDirectory root, which is D:\ on relocated-profile machines —
# verified against a real desktop install (2026-08-29). PI_CODING_AGENT_DIR
# makes omp use the bundled agent dir regardless of profile relocation.
# All Environment rows use Action="set" Permanent="yes": wixl maps that to
# the "=-" Name prefix = set on install, REMOVE on uninstall (MSDN Environment
# Table "usual behavior"). wixl defaults a missing Action to CREATE (+), which
# is never removed on uninstall. Note: wixl's Permanent=yes is the INVERSE of
# WiX semantics — here it means "remove on uninstall".
#
# Usage: bash scripts/ci-build-msi.sh <version> <omp-windows-exe> <payload-dir> <output-path>
#   version      e.g. "18.0.10" (without leading 'v')
#   omp-windows-exe  cross-compiled omp-windows-x64.exe (MZ/PE binary)
#   payload-dir  an existing omp bundle dir providing tools/, skills/, models/
#   output-path  path for the output .msi file
#
# Requires: wixl >= 0.105 (Environment support), cargo with
# x86_64-pc-windows-gnu target, x86_64-w64-mingw32-gcc/g++.

set -euo pipefail

VERSION="${1:?missing version}"
BINARY="${2:?missing binary path}"
PAYLOAD="${3:?missing payload dir}"
OUTPUT="${4:?missing output path}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SEMBLE_RS_MANIFEST="$REPO_DIR/../semble_rs/Cargo.toml"

for f in "$BINARY" "$PAYLOAD/tools/semble-rs/index.ts" "$PAYLOAD/models/potion-code-16M"; do
	[ -e "$f" ] || { echo "error: missing input: $f" >&2; exit 1; }
done
[ -d "$PAYLOAD/skills" ] && [ -n "$(ls -A "$PAYLOAD/skills")" ] || { echo "error: no skills in $PAYLOAD/skills" >&2; exit 1; }
head -c 2 "$BINARY" | od -An -tx1 | grep -q "4d 5a" || { echo "error: $BINARY is not a PE binary (no MZ magic)" >&2; exit 1; }

# WiX expects a version of the form major.minor.build (max 255.255.65535).
CLEAN_VERSION=$(echo "$VERSION" | sed 's/-.*//')
IFS='.' read -ra PARTS <<< "$CLEAN_VERSION"
MAJOR="${PARTS[0]:-0}"
MINOR="${PARTS[1]:-0}"
BUILD="${PARTS[2]:-0}"
if [ "$BUILD" -gt 65535 ] 2>/dev/null; then
	BUILD=65535
fi
WIX_VERSION="${MAJOR}.${MINOR}.${BUILD}"

# Stable UpgradeCode: every build of the same product shares the upgrade code.
UPGRADE_CODE="D7B0F8A3-4E2C-5D1F-9A6E-8B3C7F2D1A5E"

# wixl must be >= 0.105 (native <Environment> support). Prefer an explicit
# msitools-env prefix (micromamba: micromamba create -p ~/.local/msitools-env
# -c conda-forge "msitools=0.106"); system wixl 0.103 and older cannot build
# the environment-writing installer.
MAMBA_ENV="$HOME/.local/msitools-env"
if [ -x "$MAMBA_ENV/bin/wixl" ]; then
	export PATH="$MAMBA_ENV/bin:$PATH"
fi
WIXL_VERSION_FOUND=$(wixl --version 2>/dev/null | head -1)
wixl --version 2>/dev/null | grep -Eq "0\.(10[5-9]|1[1-9]|[2-9][0-9])" || {
	echo "error: wixl >= 0.105 required for <Environment> support (found: ${WIXL_VERSION_FOUND:-none})" >&2
	echo "       install: micromamba create -y -p ~/.local/msitools-env -c conda-forge 'msitools=0.106'" >&2
	exit 1
}

STAGE=$(mktemp -d /tmp/omp-msi-stage-XXXXXX)
WXS_FILE="$STAGE/omp-installer.wxs"
trap 'rm -rf "$STAGE"' EXIT

# 1. Stage the payload tree mirroring the install layout.
echo "[1/4] Staging payload..."
mkdir -p "$STAGE/payload/tools/semble-rs" "$STAGE/payload/models/potion-code-16M" "$STAGE/payload/skills"
cp "$BINARY" "$STAGE/payload/omp.exe"
cp "$PAYLOAD/tools/semble-rs/index.ts" "$STAGE/payload/tools/semble-rs/index.ts"
cp -R "$PAYLOAD/models/potion-code-16M/." "$STAGE/payload/models/potion-code-16M/"
for skill_dir in "$PAYLOAD"/skills/*/; do
	skill_name="$(basename "$skill_dir")"
	mkdir -p "$STAGE/payload/skills/$skill_name"
	cp "$skill_dir/SKILL.md" "$STAGE/payload/skills/$skill_name/SKILL.md"
done

# 2. Cross-build semble_rs.exe (same source the linux bundle builds).
echo "[2/4] Building semble_rs.exe (x86_64-pc-windows-gnu)..."
# Pin the toolchain: oh-my-pi's rust-toolchain.toml would otherwise poison
# manifest-path builds with a nightly that lacks the windows-gnu std.
RUSTUP_TOOLCHAIN=stable cargo build --release --manifest-path "$SEMBLE_RS_MANIFEST" --target x86_64-pc-windows-gnu
SEMBLE_EXE="$(dirname "$SEMBLE_RS_MANIFEST")/target/x86_64-pc-windows-gnu/release/semble_rs.exe"
[ -f "$SEMBLE_EXE" ] || { echo "error: semble_rs.exe not built at $SEMBLE_EXE" >&2; exit 1; }
cp "$SEMBLE_EXE" "$STAGE/payload/semble_rs.exe"

# 3. Generate the WiX source (component refs accumulated alongside components).
MODEL_XML=""
MODEL_REFS=""
for m in "$STAGE"/payload/models/potion-code-16M/*; do
	mname="$(basename "$m")"
	MODEL_XML+="          <Component Id=\"Model_$mname\" Guid=\"*\">
            <File Id=\"ModelFile_$mname\" Name=\"$mname\" Source=\"$STAGE/payload/models/potion-code-16M/$mname\" />
          </Component>
"
	MODEL_REFS+="      <ComponentRef Id=\"Model_$mname\" />
"
done
SKILL_XML=""
SKILL_REFS=""
for s in "$STAGE"/payload/skills/*/; do
	sname="$(basename "$s")"
	SKILL_XML+="        <Directory Id=\"SkillDir_$sname\" Name=\"$sname\">
          <Component Id=\"SkillComp_$sname\" Guid=\"*\">
            <File Id=\"SkillFile_$sname\" Name=\"SKILL.md\" Source=\"$STAGE/payload/skills/$sname/SKILL.md\" />
          </Component>
        </Directory>
"
	SKILL_REFS+="      <ComponentRef Id=\"SkillComp_$sname\" />
"
done

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
      Comments="oh-my-pi custom Windows installer"
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
          <!-- Registry keypaths: file keypaths would let MSI costing skip the
               component when an identical unversioned exe already exists on
               disk, which a following RemoveExistingProducts uninstall then
               deletes — leaving no exe after an upgrade (observed live). -->
          <Component Id="MainExecutable" Guid="*">
            <RegistryValue Root="HKCU" Key="Software\omp\components" Name="MainExe"
                           Type="integer" Value="1" KeyPath="yes" />
            <File Id="omp.exe" Name="omp.exe" Source="$STAGE/payload/omp.exe" />
          </Component>
          <Component Id="SembleRsExe" Guid="*">
            <RegistryValue Root="HKCU" Key="Software\omp\components" Name="SembleRs"
                           Type="integer" Value="1" KeyPath="yes" />
            <File Id="semble_rs.exe" Name="semble_rs.exe" Source="$STAGE/payload/semble_rs.exe" />
          </Component>
          <Directory Id="ModelsDir" Name="models">
            <Directory Id="ModelDir16M" Name="potion-code-16M">
${MODEL_XML}            </Directory>
          </Directory>
          <Component Id="UserEnv" Guid="*">
            <RegistryValue Root="HKCU" Key="Software\omp" Name="UserEnv"
                           Type="integer" Value="1" KeyPath="yes" />
            <Environment Id="EnvPath" Name="PATH" Value="[APPLICATIONFOLDER]"
                         Part="last" Action="set" Permanent="yes" System="no" />
            <Environment Id="EnvSembleBin" Name="SEMBLE_RS_BIN"
                         Value="[APPLICATIONFOLDER]semble_rs.exe" Part="all" Action="set" Permanent="yes" System="no" />
            <Environment Id="EnvSembleModel" Name="SEMBLE_MODEL_PATH"
                         Value="[APPLICATIONFOLDER]models\potion-code-16M" Part="all" Action="set" Permanent="yes" System="no" />
            <Environment Id="EnvAgentDir" Name="PI_CODING_AGENT_DIR"
                         Value="[APPLICATIONFOLDER]agent" Part="all" Action="set" Permanent="yes" System="no" />
          </Component>
          <Directory Id="AgentDir" Name="agent">
            <Directory Id="AgentToolsDir" Name="tools">
              <Directory Id="SembleToolsDir" Name="semble-rs">
                <Component Id="SembleToolIndex" Guid="*">
                  <File Id="SembleToolIndexFile" Name="index.ts"
                        Source="$STAGE/payload/tools/semble-rs/index.ts" KeyPath="yes" />
                </Component>
              </Directory>
            </Directory>
            <Directory Id="AgentSkillsDir" Name="skills">
${SKILL_XML}            </Directory>
          </Directory>
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="Complete" Title="OMP" Level="1" Display="expand"
             Description="OMP Coding Agent" ConfigurableDirectory="APPLICATIONFOLDER">
      <ComponentRef Id="MainExecutable" />
      <ComponentRef Id="SembleRsExe" />
      <ComponentRef Id="UserEnv" />
      <ComponentRef Id="SembleToolIndex" />
${MODEL_REFS}${SKILL_REFS}    </Feature>
    <!-- Remove older product versions on upgrade (Upgrade table +
         FindRelatedProducts/RemoveExistingProducts scheduling) -->
    <MajorUpgrade AllowDowngrades="no" Schedule="afterInstallValidate"
                  DowngradeErrorMessage="A newer version of [ProductName] is already installed." />

    <!-- Register with Add/Remove Programs -->
    <Property Id="ARPCONTACT" Value="https://github.com/lukeliao/oh-my-pi" />
    <Property Id="ARPURLINFOABOUT" Value="https://github.com/lukeliao/oh-my-pi" />

  </Product>
</Wix>
WIXEOF

echo "Generated WiX source: $WXS_FILE"
echo "Version: $WIX_VERSION (original: $VERSION)"

# 4. Build the MSI.
echo "[3/4] Building MSI with wixl..."
wixl --output "$OUTPUT" "$WXS_FILE"
echo "[4/4] MSI built: $OUTPUT ($(stat --format=%s "$OUTPUT") bytes)"
