import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const host = process.env["TAURI_DEV_HOST"];
const devServerHost = host || "127.0.0.1";

// Multi-page Vite config for the Tauri renderer. Each Tauri WebviewWindow
// loads its own HTML file (main at the root, secondary windows under
// windows/). Output → `dist` (Tauri `frontendDist: "../dist"`); dev server on
// the Tauri-fixed port 1430.
//
// `base: "./"` keeps asset paths relative so the packaged `file://`-style load
// of each window's HTML resolves assets from the HTML file's directory.
export default defineConfig(({ command }) => {
	// react-compiler is a babel pass over every .tsx in the graph. It only
	// matters for production (ships memoization); at dev time it dominates
	// first-window paint. Gate it on `vite build` (production) only.
	const isProdBuild = command === "build";
	return {
		root: rootDir,
		base: "./",
		// Vite 8 resolves tsconfig `paths` (@/*) natively.
		resolve: { tsconfigPaths: true },
		plugins: [
			// `messages/*.json` are pulled in via a dynamic `import()` in
			// IntlProvider (`shared/i18n/loadMessages`), which HMR does NOT re-run
			// on a JSON edit — so adding/changing a key otherwise leaves the running
			// app rendering raw key paths until a manual reload. Force a full reload
			// on any message change so new keys resolve immediately.
			{
				name: "starter-i18n-full-reload",
				handleHotUpdate({ file, server }) {
					const normalized = file.replaceAll("\\", "/");
					if (
						normalized.includes("/messages/") &&
						normalized.endsWith(".json")
					) {
						server.ws.send({ type: "full-reload" });
						return [];
					}
					return undefined;
				},
			},
			react(),
			...(isProdBuild ? [babel({ presets: [reactCompilerPreset()] })] : []),
			tailwindcss(),
		],
		// Tauri: don't obscure Rust errors; ignore src-tauri in the watcher.
		clearScreen: false,
		envPrefix: ["VITE_", "TAURI_ENV_*"],
		build: {
			outDir: "dist",
			emptyOutDir: true,
			sourcemap: false,
			// Tauri's webview (WebView2 / WebKitGTK) supports the modern ES surface.
			target: "esnext",
			// All supported Tauri webviews implement native modulepreload; skip
			// Vite's compatibility polyfill.
			modulePreload: { polyfill: false },
			reportCompressedSize: false,
			rolldownOptions: {
				input: {
					// The APP window (the settings window — the app's only top-level
					// window) is the ROOT entry, so the Tauri dev server serves it from
					// `/`. Secondary windows live under `windows/`; build output mirrors
					// the input layout (dist/windows/*).
					app: resolve(rootDir, "index.html"),
					picker: resolve(rootDir, "windows/picker.html"),
					gallery: resolve(rootDir, "windows/gallery.html"),
					overlay: resolve(rootDir, "windows/overlay.html"),
					"focus-overlay": resolve(rootDir, "windows/focus-overlay.html"),
					"magic-toolbar": resolve(rootDir, "windows/magic-toolbar.html"),
					"tray-menu": resolve(rootDir, "windows/tray-menu.html"),
				},
			},
		},
		server: {
			// Tauri expects a fixed port and fails if it's not available.
			port: 1430,
			strictPort: true,
			host: devServerHost,
			// WebView2 aggressively disk-caches dev assets and keeps serving stale
			// JS/JSON across reloads (and even dev-server restarts). `no-store`
			// makes the dev server tell the webview never to cache, so a reload
			// always picks up the latest modules.
			headers: { "Cache-Control": "no-store" },
			// Omit `hmr` entirely when there's no TAURI_DEV_HOST — under
			// `exactOptionalPropertyTypes` an explicit `hmr: undefined` is rejected.
			...(host
				? {
						hmr: {
							protocol: "ws",
							host,
							port: 1431,
						},
					}
				: {}),
			watch: {
				ignored: ["**/src-tauri/**"],
			},
		},
	};
});
