# Settings Chrome audit harness

This page mounts the real settings renderer behind an in-browser, stateful
Tauri mock. It never launches the desktop process and cannot apply physical
display, hotkey, focus, startup, file-system, or updater effects.

Start the normal Vite renderer server:

```sh
bun run dev:settings-audit
```

Then open this exact URL in Chrome:

```text
http://127.0.0.1:1430/tools/e2e/settings-audit.html
```

The mock installs before `src/entries/settings.tsx` is imported, so no Chrome
extension init script or CDP preload is needed. State and bounded call/event
logs persist in `localStorage` across reloads.

In DevTools or an automation client:

```js
await window.__DIMREAD_TEST__.ready;
window.__DIMREAD_TEST__.snapshot();
window.__DIMREAD_TEST__.calls("settings_save");
window.__DIMREAD_TEST__.failNext("settings_save", "simulated conflict");
window.__DIMREAD_TEST__.emit("diagnostics:log-line", {
  level: "INFO",
  message: "browser audit line",
  target: "settings-audit",
  timestampMs: Date.now(),
});
```

Useful controlled mutations include `patchSettings`, `setSettings`,
`setMonitors`, `setTimezones`, `setLocation`, `setOpenWindows`, `setFocus`,
`setUpdate`, `queueImport`, and `addDiagnosticIssue`. Every getter returns a
clone; the exposed API object is frozen. `reset()` restores the fixture and
clears the renderer's settings cache; call `reload()` afterward when a clean UI
mount is required.
