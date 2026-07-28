#!/usr/bin/env node
/**
 * The CI jobs that `bun run prepush` does not cover, run only when the push
 * actually touches them.
 *
 * `prepush` gates the renderer. Rust CI and the docs build were left entirely to
 * GitHub, which is why backend and documentation breakage kept being discovered
 * on a runner: `cargo clippy`, `cargo test`, the generated-bindings assertion,
 * and the Fumadocs link audit had no local pre-push equivalent at all.
 *
 * This script adds them, path-scoped the same way the workflows are, so a
 * renderer-only push still costs nothing:
 *
 *   src-tauri/**, Cargo.*, tauri.conf.json  → .github/workflows/rust-ci.yml
 *   docs-site/**                            → .github/workflows/docs.yml
 *
 * The Rust half runs twice: once on the host, and once inside the Linux
 * container from tools/linux/check-linux.mjs. The second run is the point — a
 * Windows developer's clippy never compiles the `#[cfg(not(windows))]` half of
 * this crate, so dead code and lints there are invisible until CI. It is skipped
 * with a warning when Docker is not running, because an unavailable daemon must
 * not block a push.
 *
 *   node tools/git-hooks/prepush-scoped.mjs
 *   node tools/git-hooks/prepush-scoped.mjs --all   # ignore path scoping
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const forceAll = process.argv.includes("--all");

function git(args) {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		shell: false,
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Files this push would publish.
 *
 * Against the tracking branch when there is one; otherwise against the remote's
 * main, since that is what a first push of a branch is compared with. With no
 * remote knowledge at all (a fresh clone mid-rebase, a detached head) we cannot
 * scope safely, so everything runs.
 */
function changedFiles() {
	const upstream = git([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	const base = upstream ?? "origin/main";
	if (!git(["rev-parse", "--verify", "--quiet", base])) return null;
	const diff = git(["diff", "--name-only", `${base}...HEAD`]);
	return diff === null ? null : diff.split("\n").filter(Boolean);
}

const files = forceAll ? null : changedFiles();
const touches = (predicate) => files === null || files.some(predicate);

const touchesRust = touches(
	(file) =>
		file.startsWith("src-tauri/") ||
		file === "package.json" ||
		file === "bun.lock" ||
		file === "vite.config.ts",
);
const touchesDocs = touches((file) => file.startsWith("docs-site/"));

if (!(touchesRust || touchesDocs)) {
	console.log(
		"prepush (scoped): no backend or docs changes — nothing to gate.",
	);
	process.exit(0);
}

/**
 * Run a command, streaming output; exits the process on failure.
 *
 * `shell` defaults on for Windows because `bun` is a `.cmd` shim there and
 * CreateProcess will not run one directly. Pass `shell: false` for anything
 * invoked by absolute path — cmd.exe splits an unquoted `C:\Program Files\…`
 * at the space.
 */
function step(label, command, args, options = {}) {
	console.log(`\n▸ ${label}`);
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		stdio: "inherit",
		shell: process.platform === "win32",
		...options,
	});
	if (result.status !== 0) {
		console.error(
			`\n✗ ${label} failed — fix it before pushing (CI runs the same gate).`,
		);
		process.exit(1);
	}
}

if (touchesRust) {
	// tauri::generate_context! reads build.frontendDist at compile time, so the
	// cargo gates need dist/ to exist. Same stub the Windows CI job creates.
	const distIndex = join(repoRoot, "dist", "index.html");
	if (!existsSync(distIndex)) {
		mkdirSync(dirname(distIndex), { recursive: true });
		writeFileSync(distIndex, "<!doctype html><title>pre-push stub</title>\n");
	}

	const cargo = { cwd: join(repoRoot, "src-tauri") };
	step("cargo fmt --check", "cargo", ["fmt", "--all", "--", "--check"], cargo);
	step(
		"cargo clippy -D warnings",
		"cargo",
		["clippy", "--all-targets", "--locked", "--", "-D", "warnings"],
		cargo,
	);
	step("cargo test", "cargo", ["test", "--locked"], cargo);
	// cargo test regenerates src/bindings.ts; a dirty diff means the checked-in
	// bindings are stale. Identical assertion to rust-ci.yml.
	step("generated bindings are up to date", "git", [
		"diff",
		"--exit-code",
		"src/bindings.ts",
	]);
	step(
		"Linux gates (Docker)",
		process.execPath,
		[join("tools", "linux", "check-linux.mjs"), "--skip-if-unavailable"],
		{ shell: false },
	);
}

if (touchesDocs) {
	const docs = { cwd: join(repoRoot, "docs-site") };
	step("docs typecheck", "bun", ["run", "typecheck"], docs);
	step("docs build", "bun", ["run", "build"], {
		...docs,
		env: { ...process.env, DOCS_BASE: "/dimread/" },
	});
	step("docs link audit", "bun", ["run", "check:links"], docs);
}

console.log("\n✓ prepush (scoped) clean.");
