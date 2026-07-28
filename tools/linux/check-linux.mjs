#!/usr/bin/env node
/**
 * Run the Linux half of Rust CI locally, inside Docker.
 *
 * Most of this project is developed on Windows, but `.github/workflows/rust-ci.yml`
 * also gates macOS and Linux — and the failures that reach CI are almost always
 * the same shape: an item that only the `#[cfg(windows)]` build uses goes dead
 * on the other platforms, or a clippy lint fires inside code Windows never
 * compiles. `cargo clippy` on the developer's machine cannot see any of it.
 *
 * This script closes that gap: it builds tools/linux/Dockerfile.check (the same
 * toolchain and system libraries as the ubuntu CI job) and runs fmt + check +
 * clippy + test against the live work tree, with `-D warnings`, exactly as CI
 * does.
 *
 *   node tools/linux/check-linux.mjs            # fmt, check, clippy, test
 *   node tools/linux/check-linux.mjs --quick    # clippy only (fastest signal)
 *   node tools/linux/check-linux.mjs --skip-if-unavailable
 *
 * The registry and target directory live in named Docker volumes, so the first
 * run pays a full cold build and later runs are incremental. Nothing under
 * src-tauri/target (the Windows build) is touched.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const IMAGE = "dimread-linux-check";
const REGISTRY_VOLUME = "dimread-linux-cargo-registry";
const TARGET_VOLUME = "dimread-linux-target";

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");
const skipIfUnavailable = args.has("--skip-if-unavailable");

/** Run a command, streaming its output; returns the exit status. */
function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, {
		cwd: repoRoot,
		stdio: "inherit",
		shell: false,
		...options,
	});
	if (result.error)
		return { ok: false, missing: result.error.code === "ENOENT" };
	return { ok: result.status === 0, missing: false };
}

function dockerAvailable() {
	const probe = spawnSync(
		"docker",
		["info", "--format", "{{.ServerVersion}}"],
		{
			stdio: "ignore",
			shell: false,
		},
	);
	return !probe.error && probe.status === 0;
}

if (!dockerAvailable()) {
	const message =
		"check:rust:linux needs a running Docker engine (Docker Desktop on Windows/macOS).";
	if (skipIfUnavailable) {
		console.warn(`⚠ ${message} Skipping — CI still gates Linux and macOS.`);
		process.exit(0);
	}
	console.error(`✗ ${message}`);
	console.error("  Start Docker and retry, or pass --skip-if-unavailable.");
	process.exit(1);
}

// The tauri::generate_context! macro reads build.frontendDist at compile time,
// so cargo check/clippy/test need dist/ to exist. Same stub the Windows CI job
// creates; never overwrites a real renderer build.
const distIndex = join(repoRoot, "dist", "index.html");
if (!existsSync(distIndex)) {
	mkdirSync(dirname(distIndex), { recursive: true });
	writeFileSync(distIndex, "<!doctype html><title>linux check stub</title>\n");
}

console.log(`▸ Building ${IMAGE} (cached after the first run)…`);
const built = run("docker", [
	"build",
	"--file",
	join("tools", "linux", "Dockerfile.check"),
	"--tag",
	IMAGE,
	join("tools", "linux"),
]);
if (!built.ok) {
	console.error("✗ Failed to build the Linux check image.");
	process.exit(1);
}

const steps = quick
	? ["cargo clippy --all-targets --locked -- -D warnings"]
	: [
			"cargo fmt --all -- --check",
			"cargo check --all-targets --locked",
			"cargo clippy --all-targets --locked -- -D warnings",
			"cargo test --locked",
		];

// `set -e` so the first failing gate stops the run, and `echo` marks each step
// in the streamed output.
const script = steps
	.map((step) => `echo "\n▸ ${step}" && ${step}`)
	.join(" && ");

console.log("▸ Running the Linux gates inside the container…");
const checked = run("docker", [
	"run",
	"--rm",
	"--volume",
	`${repoRoot}:/work`,
	"--volume",
	`${REGISTRY_VOLUME}:/usr/local/cargo/registry`,
	"--volume",
	`${TARGET_VOLUME}:/linux-target`,
	"--workdir",
	"/work/src-tauri",
	IMAGE,
	"bash",
	"-euo",
	"pipefail",
	"-c",
	script,
]);

if (!checked.ok) {
	console.error(
		"\n✗ Linux gates failed — this is what rust-ci.yml would report.",
	);
	process.exit(1);
}

console.log("\n✓ Linux gates clean (fmt / check / clippy -D warnings / test).");
