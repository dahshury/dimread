/**
 * Real screenshots of DimRead's real UI, for the documentation site.
 *
 * The renderer is the SAME bundle the desktop app loads — no mock-ups, no
 * redrawn look-alikes. What it normally lacks in a plain browser is the Rust
 * backend, so every window renders its empty state ("No monitors detected.").
 * This script injects a small mock of the Tauri IPC bridge before the bundle
 * boots, answering only the handful of commands the panels read on mount, and
 * then drives the real UI with Playwright.
 *
 * The settings payload is not hand-written: it is `appSettingsSchema.parse({})`
 * from the app's own zod schema, so the captured values ARE the shipped
 * defaults. Change a default and the screenshots follow.
 *
 * Run it with NODE, not Bun: Playwright drives the browser over a CDP pipe on
 * file descriptors 3/4, which Bun's child-process plumbing does not forward on
 * Windows — the browser launches and the connection then times out. The
 * settings defaults still come from the renderer's TypeScript zod schema, via a
 * one-shot `bun` subprocess (see `dump-default-settings.ts`).
 *
 * Usage (a Vite dev server must already be serving the renderer):
 *
 *   bun run dev:vite    # in one terminal
 *   bun run docs:shots  # in another
 *
 * Options:
 *   --base <url>   renderer origin (default http://127.0.0.1:1430)
 *   --out <dir>    output directory (default docs-site/public/screenshots)
 *   --only <name>  capture a single shot by id
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The shipped version, read from the same file the desktop build compiles in —
 *  the About tab's screenshot must never claim a version the app isn't. */
const APP_VERSION = JSON.parse(
	readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
).version;

function readFlag(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const BASE = readFlag("base", "http://127.0.0.1:1430").replace(/\/$/, "");
const OUT_DIR = path.resolve(
	repoRoot,
	readFlag("out", path.join("docs-site", "public", "screenshots")),
);
const ONLY = readFlag("only", null);

/** The renderer's own zod defaults, read through a one-shot Bun subprocess. */
function defaultSettings() {
	const json = execFileSync(
		"bun",
		[path.join("tools", "docs", "dump-default-settings.ts")],
		{ cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" },
	);
	return JSON.parse(json);
}

/** The shipped defaults, with a few fields set to something worth looking at. */
function settingsFixture() {
	const settings = defaultSettings();
	settings.display.mode = "reading";
	settings.hotkeys.toggleMain = "Ctrl+Shift+D";
	settings.hotkeys.toggleFilter = "Ctrl+Alt+F";
	settings.hotkeys.brightnessUp = "Ctrl+Alt+Up";
	settings.hotkeys.brightnessDown = "Ctrl+Alt+Down";
	settings.hotkeys.tempUp = "Ctrl+Alt+Right";
	settings.hotkeys.tempDown = "Ctrl+Alt+Left";
	settings.hotkeys.focusRead = "F8";
	settings.hotkeys.focusBlur = "Shift+F8";
	settings.rules.enabled = true;
	// `rules.items`, and a rule is {id, matchKind, pattern, mode} — the zod
	// schema drops anything else, which is how this list silently rendered
	// empty the first time.
	settings.rules.items = [
		{
			id: "rule-photoshop",
			matchKind: "process",
			pattern: "photoshop.exe",
			mode: "editing",
		},
		{ id: "rule-vlc", matchKind: "process", pattern: "vlc.exe", mode: "movie" },
		{
			id: "rule-kindle",
			matchKind: "title",
			pattern: "Kindle",
			mode: "reading",
		},
	];
	return settings;
}

/** Two displays, shaped exactly like `display_list_monitors` returns them. */
const MONITORS = [
	{
		id: "\\\\.\\DISPLAY1",
		index: 0,
		friendlyName: "Dell U2723QE",
		isPrimary: true,
	},
	{
		id: "\\\\.\\DISPLAY2",
		index: 1,
		friendlyName: "LG 27GP850",
		isPrimary: false,
	},
];

const OPEN_WINDOWS = [
	{
		id: "132518",
		process: "photoshop.exe",
		title: "Adobe Photoshop 2026",
		className: "Photoshop",
	},
	{
		id: "197704",
		process: "vlc.exe",
		title: "VLC media player",
		className: "Qt5152QWindowIcon",
	},
	{
		id: "265422",
		process: "Code.exe",
		title: "dimread — Visual Studio Code",
		className: "Chrome_WidgetWin_1",
	},
];

const TIMEZONES = [
	{ id: "Europe/London", country: "GB", latitude: 51.5, longitude: -0.1167 },
	{ id: "Europe/Berlin", country: "DE", latitude: 52.5167, longitude: 13.4 },
	{
		id: "America/New_York",
		country: "US",
		latitude: 40.7142,
		longitude: -74.0064,
	},
	{ id: "Asia/Riyadh", country: "SA", latitude: 24.6333, longitude: 46.7167 },
	{ id: "Asia/Tokyo", country: "JP", latitude: 35.6544, longitude: 139.7447 },
];

/**
 * The IPC mock, serialized into the page before any module runs.
 *
 * Anything not listed rejects — the same shape a real backend error takes, and
 * every panel already handles it, so an unmocked command degrades instead of
 * blanking the window.
 */
function installMockBridge({
	appVersion,
	display,
	label,
	monitors,
	openWindows,
	settings,
	timezones,
}) {
	// Everything the handlers close over must arrive through this argument:
	// Playwright serializes the function body alone, so a module-scope constant
	// referenced in here is `undefined` in the page.
	const MONITORS = monitors;
	const OPEN_WINDOWS = openWindows;
	const TIMEZONES = timezones;
	const handlers = {
		settings_load_snapshot: () => ({ revision: 1, settings }),
		settings_save: () => ({ revision: 2, settings }),
		display_list_monitors: () => MONITORS,
		display_current: () => display,
		display_set_value: () => null,
		display_preview: () => null,
		display_preview_end: () => null,
		daynight_list_timezones: () => TIMEZONES,
		daynight_location_status: () => ({
			resolved: {
				latitude: 51.5,
				longitude: -0.1167,
				source: "auto",
				timezone: "Europe/London",
			},
			detectedTimezone: "Europe/London",
			sunriseMinutes: 5 * 60 + 12,
			sunsetMinutes: 20 * 60 + 47,
		}),
		hotkey_list: () => [],
		hotkey_register: () => null,
		hotkey_unregister: () => null,
		rules_list_windows: () => OPEN_WINDOWS,
		focus_active_state: () => ({ read: false, blur: false }),
		focus_read_toggle: () => null,
		focus_blur_toggle: () => null,
		show_app_window: () => null,
		hide_app_window: () => null,
		tray_menu_resize: () => null,
		tray_menu_hide: () => null,
		magictoolbar_renderer_ready: () => null,
		"plugin:event|listen": () => 1,
		"plugin:event|unlisten": () => null,
		"plugin:event|emit": () => null,
		"plugin:event|emit_to": () => null,
		"plugin:os|platform": () => "windows",
		"plugin:os|locale": () => "en-US",
		"plugin:app|version": () => appVersion,
		"plugin:app|name": () => "DimRead",
		"plugin:app|tauri_version": () => "2.11.2",
	};

	let nextCallback = 1;
	const internals = {
		metadata: {
			currentWindow: { label },
			currentWebview: { label, windowLabel: label },
		},
		transformCallback(callback) {
			const id = nextCallback++;
			const key = `_${id}`;
			Object.defineProperty(window, key, {
				value: callback,
				writable: false,
				configurable: true,
			});
			return id;
		},
		convertFileSrc: (filePath) => filePath,
		invoke(command, ...rest) {
			const handler = handlers[command];
			if (!handler) {
				return Promise.reject(new Error(`mock: no handler for ${command}`));
			}
			return Promise.resolve(handler(rest[0] ?? {}));
		},
	};
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: internals,
		writable: false,
		configurable: true,
	});
	// Every window paints its own rounded card over a transparent desktop; a
	// flat neutral behind it keeps the PNG's corners from going pure black.
	const style = document.createElement("style");
	style.textContent = ":root,body{background:transparent !important}";
	document.documentElement.append(style);
}

/** The settings window's own size, so a capture matches what opens on screen. */
const SETTINGS_SIZE = { width: 940, height: 680 };

/**
 * Shots. `path` is the renderer entry, `label` the Tauri window label it boots
 * as, `tab` the settings rail entry to select first (its visible label), and
 * `scrollTo` an optional heading to bring into view before capturing.
 */
const SHOTS = [
	{
		id: "settings-display",
		title: "Settings → Display",
		path: "/",
		label: "settings",
		size: SETTINGS_SIZE,
	},
	{
		id: "settings-schedule",
		title: "Settings → Schedule",
		path: "/",
		label: "settings",
		size: SETTINGS_SIZE,
		tab: "Schedule",
	},
	{
		id: "settings-app-rules",
		title: "Settings → App rules",
		path: "/",
		label: "settings",
		size: SETTINGS_SIZE,
		tab: "App rules",
	},
	{
		id: "settings-window-effects",
		title: "Settings → Window effects",
		path: "/",
		label: "settings",
		size: SETTINGS_SIZE,
		tab: "Window effects",
	},
	{
		id: "settings-hotkeys",
		title: "Settings → Hotkeys",
		path: "/",
		label: "settings",
		size: SETTINGS_SIZE,
		tab: "Hotkeys",
	},
	{
		id: "settings-general",
		title: "Settings → General",
		path: "/",
		label: "settings",
		size: SETTINGS_SIZE,
		tab: "General",
	},
	{
		id: "settings-about",
		title: "Settings → About",
		path: "/",
		label: "settings",
		size: SETTINGS_SIZE,
		tab: "About",
	},
	{
		id: "tray-flyout",
		title: "The tray flyout",
		path: "/windows/tray-menu.html",
		label: "tray-menu",
		size: { width: 300, height: 460 },
		trim: true,
	},
];

async function capture(browser, shot) {
	const context = await browser.newContext({
		colorScheme: "dark",
		deviceScaleFactor: 2,
		viewport: shot.size,
	});
	const page = await context.newPage();

	// A module the dev server fails to serve does NOT blank the page — every
	// panel has a browser fallback — so the capture succeeds and silently ships
	// a picture of the fallback. That is exactly how the About tab once shipped
	// showing "0.1.0 / 2.x" instead of the real version: a long-running Vite dev
	// server answered `import("@tauri-apps/api/app")` with 504 Outdated Optimize
	// Dep. Treat a module that will not load as a failed capture, and say what
	// fixes it.
	const loadFailures = [];
	page.on("requestfailed", (request) => loadFailures.push(request.url()));
	page.on("response", (response) => {
		if (response.status() >= 400)
			loadFailures.push(`${response.status()} ${response.url()}`);
	});
	page.on("pageerror", (error) => {
		if (/dynamically imported module/i.test(error.message)) {
			loadFailures.push(error.message);
		}
	});

	const settings = settingsFixture();
	await page.addInitScript(installMockBridge, {
		appVersion: APP_VERSION,
		display: {
			kelvin: 5500,
			brightness: 85,
			mode: settings.display.mode,
			phase: "day",
			factor: 1,
			grayscaleApplied: false,
		},
		label: shot.label,
		monitors: MONITORS,
		openWindows: OPEN_WINDOWS,
		settings,
		timezones: TIMEZONES,
	});

	await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(900);

	if (shot.tab) {
		await page.getByRole("tab", { name: shot.tab, exact: true }).click();
		await page.waitForTimeout(700);
	}

	// Freeze motion so a spring mid-flight never lands in a static image.
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;transition-duration:0s !important;transition-delay:0s !important}",
	});
	await page.waitForTimeout(200);

	if (loadFailures.length > 0) {
		await context.close();
		throw new Error(
			`${shot.id}: the renderer failed to load ${loadFailures.length} resource(s), so this shot would show browser fallbacks instead of real values:\n  ${loadFailures.slice(0, 5).join("\n  ")}\n` +
				"A stale dev server is the usual cause (504 Outdated Optimize Dep) — restart `bun run dev:vite` and capture again.",
		);
	}

	// PNG first (Playwright encodes nothing else losslessly), then WebP: a
	// 2x capture of the settings window is ~2.2 MB as PNG and ~120 KB as
	// lossless-ish WebP, which is the difference between a docs page that
	// loads and one that does not.
	const png = path.join(OUT_DIR, `${shot.id}.png.tmp`);
	const file = path.join(OUT_DIR, `${shot.id}.webp`);
	const clip = shot.trim ? await paintedBounds(page, shot.size) : undefined;
	await page.screenshot({
		path: png,
		omitBackground: true,
		// The `.tmp` extension hides the format from Playwright's sniffing.
		type: "png",
		...(clip ? { clip } : {}),
	});
	await context.close();
	await sharp(png).webp({ quality: 92, effort: 6 }).toFile(file);
	await rm(png, { force: true });
	return file;
}

/**
 * The rectangle the window actually PAINTS.
 *
 * The tray flyout lives in a window Rust resizes to
 * their content at runtime, so a fixed-viewport capture leaves a large
 * transparent margin below the card. Rather than hard-code a crop per shot,
 * measure the union of every element that paints an opaque-ish background —
 * that is the card — and clip to it.
 */
async function paintedBounds(page, viewport) {
	const box = await page.evaluate(() => {
		const rects = [];
		// Chromium reports authored `oklch()` back verbatim, so parsing channels
		// out of an assumed `rgba(...)` string finds nothing. Testing for the
		// fully-transparent value works whatever colour space the token uses.
		const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
		for (const element of document.querySelectorAll("#root *")) {
			const style = getComputedStyle(element);
			if (TRANSPARENT.has(style.backgroundColor)) {
				continue;
			}
			const rect = element.getBoundingClientRect();
			if (rect.width < 8 || rect.height < 8) {
				continue;
			}
			rects.push({
				left: rect.left,
				top: rect.top,
				right: rect.right,
				bottom: rect.bottom,
			});
		}
		if (rects.length === 0) {
			return null;
		}
		return {
			left: Math.min(...rects.map((rect) => rect.left)),
			top: Math.min(...rects.map((rect) => rect.top)),
			right: Math.max(...rects.map((rect) => rect.right)),
			bottom: Math.max(...rects.map((rect) => rect.bottom)),
		};
	});
	if (!box) {
		return undefined;
	}
	// A couple of device-independent pixels of breathing room keeps the card's
	// outer shadow from being sliced off.
	const pad = 2;
	const x = Math.max(0, Math.floor(box.left - pad));
	const y = Math.max(0, Math.floor(box.top - pad));
	return {
		x,
		y,
		width: Math.min(viewport.width - x, Math.ceil(box.right - x + pad)),
		height: Math.min(viewport.height - y, Math.ceil(box.bottom - y + pad)),
	};
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const shots = ONLY ? SHOTS.filter((shot) => shot.id === ONLY) : SHOTS;
	if (shots.length === 0) {
		throw new Error(`no shot matches --only ${ONLY}`);
	}
	const browser = await chromium.launch();
	try {
		for (const shot of shots) {
			const file = await capture(browser, shot);
			console.log(`✓ ${shot.id.padEnd(22)} ${path.relative(repoRoot, file)}`);
		}
	} finally {
		await browser.close();
	}
	console.log(
		`\n${shots.length} screenshot(s) → ${path.relative(repoRoot, OUT_DIR)}`,
	);
}

await main();
