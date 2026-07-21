/**
 * Pure state model for the Magic Toolbar window (F9.2). The toolbar view is a
 * thin renderer over these transitions: the `magictoolbar:show` /
 * `magictoolbar:hide` events and the Dark / Gray / Close button clicks all map
 * to one of the functions below, so the (small) logic is unit-tested without a
 * DOM.
 */

/** Whether the toolbar is visible and which per-window effects its target has. */
export interface ToolbarState {
	visible: boolean;
	dark: boolean;
	gray: boolean;
}

export const INITIAL_TOOLBAR_STATE: ToolbarState = {
	visible: false,
	dark: false,
	gray: false,
};

/** `magictoolbar:show` landed — reveal with the target's current effect flags. */
export function onShow(dark: boolean, gray: boolean): ToolbarState {
	return { visible: true, dark, gray };
}

/** `magictoolbar:hide` landed — play the exit (keep the last flags for the
 *  fade-out; a later show overwrites them). */
export function onHide(prev: ToolbarState): ToolbarState {
	return { ...prev, visible: false };
}

/** Optimistic Dark toggle (the backend re-asserts the true flags on the next
 *  watcher tick). */
export function toggleDark(prev: ToolbarState): ToolbarState {
	return { ...prev, dark: !prev.dark };
}

/** Optimistic Gray toggle. */
export function toggleGray(prev: ToolbarState): ToolbarState {
	return { ...prev, gray: !prev.gray };
}

/** Close/restore: clear both effects but keep the toolbar visible (the cursor
 *  is still over its target). */
export function cleared(prev: ToolbarState): ToolbarState {
	return { ...prev, dark: false, gray: false };
}

/** Whether any effect is active — the Close button only shows while one is. */
export function isEffectActive(state: ToolbarState): boolean {
	return state.dark || state.gray;
}
