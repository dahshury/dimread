/** Renderer-facing native events. Command names live exclusively in bindings. */
export const NATIVE_EVENTS = {
	SETTINGS_CHANGED: "settings:changed",
	DOWNLOAD_UPDATE: "download:update",
	PICKER_ANCHOR: "picker:anchor",
	PICKER_CLOSING: "picker:closing",
	/** A registered global hotkey fired (key-down edge). */
	HOTKEY_TRIGGERED: "hotkey:triggered",
	/** Show/replace the overlay pill's notification (resolved payload). */
	OVERLAY_NOTIFY: "overlay:notify",
	/** Early dismiss: the overlay renderer plays its exit animation now. */
	OVERLAY_DISMISS: "overlay:dismiss",
	/**
	 * Renderer-to-renderer broadcast (emitted via `@tauri-apps/api/event`, not
	 * Rust): the picker window announces a selection/favorites change so every
	 * other window's `picker-selection` store converges without polling
	 * localStorage (webviews share the storage file but do NOT receive cross-
	 * window `storage` events reliably).
	 */
	PICKER_SELECTED: "picker:selected",
	/**
	 * Renderer-to-renderer broadcast (emitted via `@tauri-apps/api/event`, not
	 * Rust): a surface hosting the display sliders announces its IN-FLIGHT drag
	 * so every other surface showing the same target tracks it live. A drag is
	 * not persisted per frame, so `settings:changed` stays silent until release
	 * — without this the tray flyout and the Display tab would drift apart for
	 * the whole duration of a drag.
	 */
	DISPLAY_EDIT: "display:edit",
} as const;

export type NativeEventName =
	(typeof NATIVE_EVENTS)[keyof typeof NATIVE_EVENTS];
