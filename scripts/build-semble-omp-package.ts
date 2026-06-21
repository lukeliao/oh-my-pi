// Build a host-native omp-semble bundle: compiled omp binary + semble_rs helper
// + custom tools + local Model2Vec model, packaged for distribution to other machines.
//
// Usage: bun scripts/build-semble-omp-package.ts [--version X.Y.Z-semble.N] [--out-dir <path>] [--model-path <path>] [--force]

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
	console.error("omp-semble packaging currently supports POSIX hosts only.");
	process.exit(1);
}

// Version resolution
const VERSION_RE = /^\d+\.\d+\.\d+-semble\.[0-9A-Za-z.-]+$/;
let version = (flags.version as string) || "";
if (!version) {
	const now = new Date();
	const y = String(now.getFullYear());
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const h = String(now.getHours()).padStart(2, "0");
	const min = String(now.getMinutes()).padStart(2, "0");
	version = `${pkgVersion}-semble.${y}${m}${d}${h}${min}`;
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
	: path.join(process.env.HOME ?? "/tmp", ".local", "share", "omp-semble-bundles");

const platformArch = `${process.platform}-${process.arch}`;
const bundleName = `omp-semble-${version}-${platformArch}`;
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
const skillsDir = path.join(bundleDir, "skills", "semble-omp-packaging");
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(toolsDir, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });
fs.mkdirSync(skillsDir, { recursive: true });

// Copy skill file into bundle
const skillSrc = path.join(repoRoot, ".omp", "skills", "semble-omp-packaging", "SKILL.md");
if (fs.existsSync(skillSrc)) {
	fs.copyFileSync(skillSrc, path.join(skillsDir, "SKILL.md"));
}

const ompBuildOutfile = path.relative(repoRoot, path.join(libDir, "omp"));

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------


async function build() {
	// 1. Build semble_rs binary
	console.log("[1/4] Building semble_rs...");
	await spawn(
		["cargo", "build", "--release", "--manifest-path", "../semble_rs/Cargo.toml"],
		repoRoot,
	);

	// 2. Generate tool-views.generated.js
	console.log("[2/4] Generating tool-views.generated.js...");
	await spawn(["bun", "--cwd=packages/collab-web", "run", "build:tool-views"], repoRoot);

	// 3. Build natives
	console.log("[3/4] Building native addons...");
	await spawn(["bun", "--cwd=packages/natives", "run", "build"], repoRoot);

	// 4. Build omp with custom version and output path
	console.log(`[4/4] Building omp (version=${version}, outfile=${ompBuildOutfile})...`);
	await spawn(
		[
			"bun",
			"--cwd=packages/coding-agent",
			"run",
			"build",
		],
		repoRoot,
		{
			...Bun.env,
			OMP_BUILD_VERSION_OVERRIDE: version,
			OMP_BUILD_OUTFILE: ompBuildOutfile,
		},
	);
}

async function spawn(
	args: string[],
	cwd: string,
	extraEnv?: Record<string, string>,
): Promise<void> {
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
	// Copy lib/omp (already built at libDir/omp)
	console.log("Copying lib/omp...");

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

	// Write VERSION
	fs.writeFileSync(path.join(bundleDir, "VERSION"), version + "\n");

	// Generate bin/omp-semble wrapper
	const wrapper = `#!/usr/bin/env sh
set -eu
# Resolve symlinks to find the real bundle root
SELF="$0"
while [ -L "$SELF" ]; do
  TARGET="\$(readlink "$SELF")"
  DIR="\$(dirname -- "$SELF")"
  case "\$TARGET" in
    /*) SELF="\$TARGET" ;;
    *) SELF="\$DIR/\$TARGET" ;;
  esac
done
ROOT="\$(CDPATH= cd -- "\$(dirname -- "$SELF")/.." && pwd)"
export OMP_SEMBLE_HOME="\${OMP_SEMBLE_HOME:-$ROOT}"
export SEMBLE_RS_BIN="\${SEMBLE_RS_BIN:-$ROOT/lib/semble_rs}"
export SEMBLE_MODEL_PATH="\${SEMBLE_MODEL_PATH:-$ROOT/models/potion-code-16M}"
exec "$ROOT/lib/omp" "$@"
`;
	const wrapperPath = path.join(binDir, "omp-semble");
	fs.writeFileSync(wrapperPath, wrapper);
	fs.chmodSync(wrapperPath, 0o755);

	// Generate install.sh
	const installer = `#!/usr/bin/env sh
set -eu

PREFIX="\${HOME}/.local/bin"
AGENT_DIR="\${HOME}/.omp/agent"
FORCE=false

while [ \$# -gt 0 ]; do
	case "\$1" in
		--prefix) PREFIX="\$2"; shift 2 ;;
		--agent-dir) AGENT_DIR="\$2"; shift 2 ;;
		--force) FORCE=true; shift ;;
		*) echo "Unknown flag: \$1"; exit 1 ;;
	esac
done

ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"

mkdir -p "\$PREFIX" "\$AGENT_DIR/tools/semble-rs" "\$AGENT_DIR/skills/semble-omp-packaging" "\$AGENT_DIR"

cp "\$ROOT/tools/semble-rs/index.ts" "\$AGENT_DIR/tools/semble-rs/index.ts"
cp "\$ROOT/skills/semble-omp-packaging/SKILL.md" "\$AGENT_DIR/skills/semble-omp-packaging/SKILL.md"

if [ ! -f "\$AGENT_DIR/config.yml" ]; then
	cat > "\$AGENT_DIR/config.yml" << 'EOF'
tools:
  discoveryMode: off
EOF
	echo "Created \$AGENT_DIR/config.yml"
else
	echo "Existing config.yml kept: \$AGENT_DIR/config.yml"
fi

OFFICIAL_AGENT="\${HOME}/.omp/agent"
for f in models.yml mcp.json; do
  if [ ! -f "\$AGENT_DIR/\$f" ] && [ -f "\$OFFICIAL_AGENT/\$f" ]; then
    cp "\$OFFICIAL_AGENT/\$f" "\$AGENT_DIR/\$f"
    echo "Copied \$f from official omp config"
  fi
done

OMP_SEMBLE_LINK="\$PREFIX/omp-semble"
if [ -e "\$OMP_SEMBLE_LINK" ] || [ -L "\$OMP_SEMBLE_LINK" ]; then
	if [ "\$FORCE" = false ]; then
		echo "Refusing to overwrite existing omp-semble at \$OMP_SEMBLE_LINK"
		exit 1
	fi
	rm -f "\$OMP_SEMBLE_LINK"
fi
ln -s "\$ROOT/bin/omp-semble" "\$OMP_SEMBLE_LINK"

echo "Installed omp-semble: \$OMP_SEMBLE_LINK"
echo "Agent dir: \$AGENT_DIR"
`;
	const installerPath = path.join(bundleDir, "install.sh");
	fs.writeFileSync(installerPath, installer);
	fs.chmodSync(installerPath, 0o755);

	// Generate README.md
	const readme = `# omp-semble ${version}

Custom oh-my-pi distribution with integrated semble_rs code-search tools.

**This installs \`omp-semble\`, never overwrites official \`omp\`.**

## Verify

| Command | Expected |
|---|---|
| \`omp-semble --version\` | Contains \`${version}\` (with \`-semble.\`) |
| \`omp --version\` | Does NOT contain \`-semble.\` |
| \`which omp-semble\` | Points to your install prefix |
| \`which omp\` | Points to official install (unchanged) |

## Wrapper defaults

The \`omp-semble\` wrapper sets:
- \`PI_CODING_AGENT_DIR\` → \`~/.omp/agent-semble\` (isolated from official omp)
- \`SEMBLE_RS_BIN\` → \`<bundle>/lib/semble_rs\`
- \`SEMBLE_MODEL_PATH\` → \`<bundle>/models/potion-code-16M\`

These are only defaults; explicitly set env vars take precedence.

## Install

\\\`\\\`\\\`bash
./install.sh                    # defaults: ~/.local/bin, ~/.omp/agent-semble
./install.sh --prefix /usr/local/bin --agent-dir ~/.omp/agent-semble
./install.sh --force            # overwrite existing symlink
\\\`\\\`\\\`
`;
	fs.writeFileSync(path.join(bundleDir, "README.md"), readme);

	// Generate SHA256SUMS
	const sumEntries: string[] = [];
	const filesToSum = [
		"bin/omp-semble",
		"lib/omp",
		`lib/semble_rs${exeSuffix}`,
		"tools/semble-rs/index.ts",
		"skills/semble-omp-packaging/SKILL.md",
		...requiredModelFiles.map(f => `models/potion-code-16M/${f}`),
	];
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
	fs.writeFileSync(path.join(bundleDir, "SHA256SUMS"), sumEntries.join("\n") + "\n");

	console.log(`\nBundle: ${bundleDir}`);
	console.log(`  omp-semble ${version} (${platformArch})`);
	console.log(`  ${sumEntries.length} files checksummed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await build();
await packageBundle();
