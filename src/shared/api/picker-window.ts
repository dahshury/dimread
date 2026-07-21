import { commands } from "@/bindings";

/**
 * Open the detached picker window anchored to a trigger's viewport rect.
 *
 * The rect is measured in the CALLING window's client coordinates
 * (`element.getBoundingClientRect()`); Rust converts it to a screen anchor,
 * sizes the transparent backdrop to the work area, and emits `picker:anchor`
 * with the window-local panel rect the picker view draws at.
 */
export function openPickerAtRect(
	rect: Pick<DOMRect, "height" | "width" | "x" | "y">,
): void {
	void commands.openWindow("picker", rect.x, rect.y, rect.width, rect.height);
}

/** Animated close (emits `picker:closing`, hides after the fade grace). */
export function closePicker(): void {
	void commands.closeWindow("picker");
}
