// Build a host-native omp bundle: compiled omp binary + semble_rs helper
// + custom tools + local Model2Vec model, packaged for distribution to other machines.
//
// Usage: bun scripts/build-semble-omp-package.ts [--version X.Y.Z-custom.N] [--out-dir <path>] [--model-path <path>] [--force]

import * as fs from "node:fs";
import * as path from "node:path";
import { version as pkgVersion } from "../packages/utils/package.json" with { type: "json" };

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg.startsWith("--")) {
		const next = args[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags[arg.slice(2)] = next;
			i++;
		} else {
			flags[arg.slice(2)] = true;
		}
	}
}

const force = flags.force === true;
const repoRoot = path.resolve(import.meta.dir, "..");

if (process.platform === "win32") {
	console.error("omp packaging currently supports POSIX hosts only.");
	process.exit(1);
}

// Version resolution
const VERSION_RE = /^\d+\.\d+\.\d+-custom\.[0-9A-Za-z.-]+$/;
let version = (flags.version as string) || "";
if (!version) {
	const now = new Date();
	const y = String(now.getFullYear());
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const h = String(now.getHours()).padStart(2, "0");
	const min = String(now.getMinutes()).padStart(2, "0");
	version = `${pkgVersion}-custom.${y}${m}${d}${h}${min}`;
}
if (!VERSION_RE.test(version)) {
	console.error(`Invalid semble OMP version: ${version}`);
	process.exit(1);
}

// Model path
const modelPath = (flags["model-path"] as string) || process.env.SEMBLE_MODEL_PATH || "";
if (!modelPath) {
	console.error("Missing --model-path or SEMBLE_MODEL_PATH");
	process.exit(1);
}
const absModelPath = path.resolve(modelPath);
const requiredModelFiles = ["config.json", "model.safetensors", "modules.json", "tokenizer.json"];
for (const f of requiredModelFiles) {
	if (!fs.existsSync(path.join(absModelPath, f))) {
		console.error(`Missing local Model2Vec model file: ${f}`);
		process.exit(1);
	}
}

// Output directory
const outDir = (flags["out-dir"] as string)
	? path.resolve(flags["out-dir"] as string)
	: path.join(process.env.HOME ?? "/tmp", ".local", "share", "omp-bundles");

const platformArch = `${process.platform}-${process.arch}`;
const bundleName = `omp-${version}-${platformArch}`;
const bundleDir = path.join(outDir, bundleName);

if (fs.existsSync(bundleDir)) {
	if (!force) {
		console.error(`Bundle already exists: ${bundleDir}`);
		process.exit(1);
	}
	fs.rmSync(bundleDir, { recursive: true, force: true });
}

// Create all required directories before build
const libDir = path.join(bundleDir, "lib");
const binDir = path.join(bundleDir, "bin");
const toolsDir = path.join(bundleDir, "tools", "semble-rs");
const modelsDir = path.join(bundleDir, "models", "potion-code-16M");
const skillsDir = path.join(bundleDir, "skills");
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(toolsDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });
fs.mkdirSync(skillsDir, { recursive: true });

// Copy ALL repo-level agent skills (.omp/skills/<name>/SKILL.md) into the
// bundle so install.sh deploys them user-level — not just omp-packaging.
const bundledSkillFiles: string[] = [];
const repoSkillsDir = path.join(repoRoot, ".omp", "skills");
if (fs.existsSync(repoSkillsDir)) {
	for (const name of fs.readdirSync(repoSkillsDir)) {
		const skillSrc = path.join(repoSkillsDir, name, "SKILL.md");
		if (fs.statSync(skillSrc).isFile()) {
			fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
			fs.copyFileSync(skillSrc, path.join(skillsDir, name, "SKILL.md"));
			bundledSkillFiles.push(`skills/${name}/SKILL.md`);
		}
	}
}

const ompBuildOutfile = path.relative(repoRoot, path.join(libDir, "omp"));

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

async function build() {
	// 1. Build semble_rs binary
	console.log("[1/4] Building semble_rs...");
	await spawn(["cargo", "build", "--release", "--manifest-path", "../semble_rs/Cargo.toml"], repoRoot);

	// 2. Generate tool-views.generated.js
	console.log("[2/4] Generating tool-views.generated.js...");
	await spawn(["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"], repoRoot);

	// 3. Build natives
	console.log("[3/4] Building native addons...");
	await spawn(["bun", "--cwd=packages/natives", "run", "build"], repoRoot);

	// 4. Build omp with custom version and output path.
	// Upstream removed OMP_BUILD_VERSION_OVERRIDE in v17.1.x; patch
	// package.json version temporarily so the binary reports the semble version.
	console.log(`[4/4] Building omp (version=${version}, outfile=${ompBuildOutfile})...`);
	const pkgJsonPath = path.join(repoRoot, "packages", "utils", "package.json");
	const originalPkgJson = fs.readFileSync(pkgJsonPath, "utf-8");
	const pkgJson = JSON.parse(originalPkgJson);
	const originalVersion = pkgJson.version;
	pkgJson.version = version;
	fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
	try {
		await spawn(["bun", "--cwd=packages/coding-agent", "run", "build"], repoRoot, {
			OMP_BUILD_OUTFILE: ompBuildOutfile,
		});
	} finally {
		pkgJson.version = originalVersion;
		fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
	}
}

async function spawn(args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<void> {
	console.log(`  → ${args.join(" ")}`);
	const proc = Bun.spawn(args, {
		cwd,
		env: { ...Bun.env, ...(extraEnv ?? {}) },
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) {
		console.error(`Build step failed with exit code ${code}: ${args.join(" ")}`);
		process.exit(1);
	}
}

async function packageBundle() {
	// Copy omp binary from dist (OMP_BUILD_OUTFILE env var no longer supported upstream)
	const ompSrc = path.join(repoRoot, "packages", "coding-agent", "dist", "omp");
	if (!fs.existsSync(ompSrc)) {
		console.error(`omp binary not found: ${ompSrc}`);
		process.exit(1);
	}
	fs.copyFileSync(ompSrc, path.join(libDir, "omp"));
	console.log(`  → ${ompSrc} -> lib/omp`);

	// Copy semble_rs binary
	const exeSuffix = process.platform === "win32" ? ".exe" : "";
	const sembleSrc = path.join(repoRoot, "..", "semble_rs", "target", "release", `semble_rs${exeSuffix}`);
	if (!fs.existsSync(sembleSrc)) {
		console.error(`semble_rs binary not found: ${sembleSrc}`);
		process.exit(1);
	}
	fs.copyFileSync(sembleSrc, path.join(libDir, `semble_rs${exeSuffix}`));
	console.log(`  → ${sembleSrc} -> lib/semble_rs`);

	// Copy custom tool index.ts
	const toolSrc = path.join(repoRoot, ".omp", "tools", "semble-rs", "index.ts");
	if (!fs.existsSync(toolSrc)) {
		console.error(`Custom tool index.ts not found: ${toolSrc}`);
		process.exit(1);
	}
	fs.copyFileSync(toolSrc, path.join(toolsDir, "index.ts"));
	console.log(`  → .omp/tools/semble-rs/index.ts -> tools/semble-rs/index.ts`);

	// Copy model files
	for (const f of requiredModelFiles) {
		fs.copyFileSync(path.join(absModelPath, f), path.join(modelsDir, f));
	}
	console.log(`  → model files copied to models/potion-code-16M/`);
	// Pre-seed mnemopi fastembed-runtime cache. Without this, the first
	// `recall`/`retain` on a network-restricted host (e.g. no direct npm CDN
	// access) triggers an on-demand `bun install` of fastembed+onnxruntime-node
	// into ~/.omp/cache/fastembed-runtime/<version-key>; if that install hangs
	// the whole agent stalls at "working" with no output (CNP6S incident).
	const feRuntimeSrc = path.join(process.env.HOME ?? "/root", ".omp", "cache", "fastembed-runtime");
	if (fs.existsSync(feRuntimeSrc)) {
		const feRuntimeDst = path.join(bundleDir, "cache", "fastembed-runtime");
		fs.cpSync(feRuntimeSrc, feRuntimeDst, { recursive: true });
		console.log(`  → fastembed-runtime cache copied to cache/fastembed-runtime/`);
	} else {
		console.warn(`  ⚠ fastembed-runtime cache not found at ${feRuntimeSrc}`);
		console.warn(`    Bundle will rely on on-demand npm install at first use.`);
	}
	// Pre-seed mnemopi fastembed model cache (~/.omp/cache/fastembed/).
	// fastembed downloads model_optimized.onnx (~12MB) and 4 config/tokenizer
	// sidecars from HuggingFace on first use; on a network-restricted host that
	// fetch stalls the same way the runtime install does. Copy the complete,
	// verified model dir, excluding stale .corrupt-* and tarball artifacts.
	const feModelSrc = path.join(process.env.HOME ?? "/root", ".omp", "cache", "fastembed");
	const feModelDst = path.join(bundleDir, "cache", "fastembed");
	fs.mkdirSync(feModelDst, { recursive: true });
	let modelCopied = false;
	const cachedModelFiles: string[] = [];
	for (const entry of fs.readdirSync(feModelSrc, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const modelVersionDir = path.join(feModelSrc, entry.name);
		const onnxPath = path.join(modelVersionDir, "model_optimized.onnx");
		if (!fs.existsSync(onnxPath)) continue;
		const dstDir = path.join(feModelDst, entry.name);
		fs.mkdirSync(dstDir, { recursive: true });
		for (const f of fs.readdirSync(modelVersionDir)) {
			if (f.startsWith("model_optimized.onnx.corrupt") || f.endsWith(".tar.gz")) continue;
			fs.copyFileSync(path.join(modelVersionDir, f), path.join(dstDir, f));
			cachedModelFiles.push(`cache/fastembed/${entry.name}/${f}`);
		}
		modelCopied = true;
		console.log(`  → fastembed model '${entry.name}' copied (weights + sidecars)`);
	}
	if (!modelCopied) {
		console.warn(`  ⚠ no fastembed model with live model_optimized.onnx found under ${feModelSrc}`);
		console.warn(`    Bundle will rely on HuggingFace download at first use.`);
	}

	// Write VERSION
	fs.writeFileSync(path.join(bundleDir, "VERSION"), `${version}\n`);

	// Generate bin/omp wrapper
	const wrapper = `#!/usr/bin/env sh
set -eu
# Resolve symlinks to find the real bundle root
SELF="$0"
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  DIR="$(dirname -- "$SELF")"
  case "$TARGET" in
    /*) SELF="$TARGET" ;;
    *) SELF="$DIR/$TARGET" ;;
  esac
done
ROOT="$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)"
export OMP_HOME="\${OMP_HOME:-$ROOT}"
export PI_CODING_AGENT_DIR="\${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
export SEMBLE_RS_BIN="\${SEMBLE_RS_BIN:-$ROOT/lib/semble_rs}"
export SEMBLE_MODEL_PATH="\${SEMBLE_MODEL_PATH:-$ROOT/models/potion-code-16M}"
exec "$ROOT/lib/omp" "$@"
`;
	const wrapperPath = path.join(binDir, "omp");
	fs.writeFileSync(wrapperPath, wrapper);
	fs.chmodSync(wrapperPath, 0o755);

	// Generate install.sh
	const installer = `#!/usr/bin/env sh
set -eu

PREFIX="\${HOME}/.local/bin"
AGENT_DIR="\${HOME}/.omp/agent"
FORCE=false

while [ $# -gt 0 ]; do
	case "$1" in
		--prefix) PREFIX="$2"; shift 2 ;;
		--agent-dir) AGENT_DIR="$2"; shift 2 ;;
		--force) FORCE=true; shift ;;
		*) echo "Unknown flag: $1"; exit 1 ;;
	esac
done

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

mkdir -p "$PREFIX" "$AGENT_DIR/tools/semble-rs" "$AGENT_DIR"

cp "$ROOT/tools/semble-rs/index.ts" "$AGENT_DIR/tools/semble-rs/index.ts"
for skill_dir in "$ROOT"/skills/*/; do
	skill_name="$(basename "$skill_dir")"
	mkdir -p "$AGENT_DIR/skills/$skill_name"
	cp "$skill_dir/SKILL.md" "$AGENT_DIR/skills/$skill_name/SKILL.md"
done

if [ ! -f "$AGENT_DIR/config.yml" ]; then
	touch "$AGENT_DIR/config.yml"
	echo "Created empty $AGENT_DIR/config.yml"
else
	echo "Existing config.yml kept: $AGENT_DIR/config.yml"
fi

OFFICIAL_AGENT="\${HOME}/.omp/agent"
for f in models.yml mcp.json; do
  if [ ! -f "$AGENT_DIR/$f" ] && [ -f "$OFFICIAL_AGENT/$f" ]; then
    cp "$OFFICIAL_AGENT/$f" "$AGENT_DIR/$f"
    echo "Copied $f from official omp config"
  fi
done

# Pre-seed mnemopi fastembed-runtime cache (avoids first-use on-demand npm install).
# fastembed-runtime/<version-key>/ encodes the pinned fastembed+ort version, so
# copy each missing version-key subdir without clobbering existing ones (handles
# both fresh installs and bundle upgrades that bump the fastembed pin).
FE_CACHE="\${HOME}/.omp/cache/fastembed-runtime"
if [ -d "$ROOT/cache/fastembed-runtime" ]; then
  mkdir -p "$FE_CACHE"
  for vkey in "$ROOT/cache/fastembed-runtime"/*; do
    [ -d "$vkey" ] || continue
    name="$(basename "$vkey")"
    # Validate completeness: ensureRuntimeInstalled probes only
    # node_modules/fastembed/package.json, but an interrupted install can leave
    # that manifest yet miss the .node/.so native bindings that actually load.
    # Require the native payloads (linux-x64) too; re-seed if any are missing.
    nm="$FE_CACHE/$name/node_modules"
    complete=true
    for f in \
      "fastembed/package.json" \
      "onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node" \
      "onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1" \
      "@anush008/tokenizers-linux-x64-gnu/tokenizers.linux-x64-gnu.node"; do
      [ -f "$nm/$f" ] || complete=false
    done
    if [ "$complete" = false ]; then
      rm -rf "$FE_CACHE/$name"
      cp -r "$vkey" "$FE_CACHE/$name"
      echo "Pre-seeded fastembed-runtime/$name (skips first-use network install)"
    fi
  done
fi

# Pre-seed mnemopi fastembed model weights + config sidecars
# (avoids first-use HuggingFace download of model_optimized.onnx + tokenizers).
FE_MODEL_CACHE="\${HOME}/.omp/cache/fastembed"
if [ -d "$ROOT/cache/fastembed" ]; then
  mkdir -p "$FE_MODEL_CACHE"
  for model_dir in "$ROOT/cache/fastembed"/*; do
    [ -d "$model_dir" ] || continue
    name="$(basename "$model_dir")"
    # Validate completeness against the full sidecar set fastembed requires
    # (config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json
    # — see ensureFastembedModelSidecars). A stale dir from a failed sidecar
    # download passes a bare existence check but crashes at load; re-seed if
    # model_optimized.onnx or any required sidecar is missing.
    complete=true
    for f in model_optimized.onnx config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do
      [ -f "$FE_MODEL_CACHE/$name/$f" ] || complete=false
    done
    if [ "$complete" = false ]; then
      rm -rf "$FE_MODEL_CACHE/$name"
      cp -r "$model_dir" "$FE_MODEL_CACHE/$name"
      echo "Pre-seeded fastembed model $name (weights + sidecars)"
    fi
  done
fi

OMP_LINK="$PREFIX/omp"
if [ -e "$OMP_LINK" ] || [ -L "$OMP_LINK" ]; then
	if [ "$FORCE" = false ]; then
		echo "Refusing to overwrite existing omp at $OMP_LINK"
		exit 1
	fi
	rm -f "$OMP_LINK"
fi
ln -s "$ROOT/bin/omp" "$OMP_LINK"

echo "Installed omp: $OMP_LINK"
echo "Agent dir: $AGENT_DIR"
`;
	const installerPath = path.join(bundleDir, "install.sh");
	fs.writeFileSync(installerPath, installer);
	fs.chmodSync(installerPath, 0o755);

	// Generate README.md
	const readme = `# omp ${version}

Custom oh-my-pi distribution with integrated semble_rs code-search tools.

**This installs \`omp\`, never overwrites official \`omp\`.**

## Verify

| Command | Expected |
|---|---|
| \`omp --version\` | Contains \`${version}\` (with \`-custom.\`) |
| \`omp --version\` | Does NOT contain \`-custom.\` |
| \`which omp\` | Points to your install prefix |
| \`which omp\` | Points to official install (unchanged) |

## Wrapper defaults

The \`omp\` wrapper sets:
- \`PI_CODING_AGENT_DIR\` → \`~/.omp/agent\` (isolated from official omp)
- \`SEMBLE_RS_BIN\` → \`<bundle>/lib/semble_rs\`
- \`SEMBLE_MODEL_PATH\` → \`<bundle>/models/potion-code-16M\`

These are only defaults; explicitly set env vars take precedence.

## Install

\\\`\\\`\\\`bash
./install.sh                    # defaults: ~/.local/bin, ~/.omp/agent
./install.sh --prefix /usr/local/bin --agent-dir ~/.omp/agent
./install.sh --force            # overwrite existing symlink
\\\`\\\`\\\`
`;
	fs.writeFileSync(path.join(bundleDir, "README.md"), readme);

	// Generate SHA256SUMS
	const sumEntries: string[] = [];
	const filesToSum = [
		"bin/omp",
		"lib/omp",
		`lib/semble_rs${exeSuffix}`,
		"tools/semble-rs/index.ts",
		...bundledSkillFiles,
		...requiredModelFiles.map(f => `models/potion-code-16M/${f}`),
		// Pre-seeded fastembed model weights + sidecars (the corrupt-ONNX
		// failure mode is exactly what these hashes defend against).
		...cachedModelFiles,
	];
	// Runtime cache: hash version manifests + the actual native payloads that
	// load at runtime (the executables, not just package.json). On linux-x64
	// these are onnxruntime_binding.node + libonnxruntime*.so (the ORT backend)
	// and the @anush008 tokenizers .node. A truncated/mismatched binding would
	// pass package.json checks but segfault at load — exactly the failure mode
	// the corrupt-ONNX incident taught us to defend against.
	const runtimeCacheDir = path.join(bundleDir, "cache", "fastembed-runtime");
	if (fs.existsSync(runtimeCacheDir)) {
		for (const vkey of fs.readdirSync(runtimeCacheDir, { withFileTypes: true })) {
			if (!vkey.isDirectory()) continue;
			const nm = `cache/fastembed-runtime/${vkey.name}/node_modules`;
			// Version manifests.
			for (const pkg of ["fastembed", "onnxruntime-node", "onnxruntime-common"]) {
				const m = `${nm}/${pkg}/package.json`;
				if (fs.existsSync(path.join(bundleDir, m))) filesToSum.push(m);
			}
			// ORT native bindings (linux-x64; bundle is host-native x64 only).
			const ortBin = `${nm}/onnxruntime-node/bin/napi-v3/linux/x64`;
			for (const f of ["onnxruntime_binding.node", "libonnxruntime.so.1", "libonnxruntime_providers_shared.so"]) {
				const p = `${ortBin}/${f}`;
				if (fs.existsSync(path.join(bundleDir, p))) filesToSum.push(p);
			}
			// Tokenizers native binding (linux-x64-gnu).
			const tok = `${nm}/@anush008/tokenizers-linux-x64-gnu/tokenizers.linux-x64-gnu.node`;
			if (fs.existsSync(path.join(bundleDir, tok))) filesToSum.push(tok);
		}
	}
	for (const rel of filesToSum) {
		const absPath = path.join(bundleDir, rel);
		if (!fs.existsSync(absPath)) continue;
		const bytes = await Bun.file(absPath).arrayBuffer();
		const hashBytes = await crypto.subtle.digest("SHA-256", bytes);
		const hex = Array.from(new Uint8Array(hashBytes))
			.map(b => b.toString(16).padStart(2, "0"))
			.join("");
		sumEntries.push(`${hex}  ${rel}`);
	}
	fs.writeFileSync(path.join(bundleDir, "SHA256SUMS"), `${sumEntries.join("\n")}\n`);

	console.log(`\nBundle: ${bundleDir}`);
	console.log(`  omp ${version} (${platformArch})`);
	console.log(`  ${sumEntries.length} files checksummed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await build();
await packageBundle();
