import { useEffect, useState } from "react";
import { commands, events, type FocusState } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";
import { useTransparentBody } from "@/shared/lib/window-effects";
import { FocusBlurShade } from "./FocusBlurShade";
import { FocusReadShade } from "./FocusReadShade";

const INACTIVE: FocusState = { read: false, blur: false };

/**
 * The `focus-overlay` window's whole surface — a transparent, click-through
 * tint that spans the entire virtual screen (all monitors). It hosts BOTH Focus
 * Read (a moving clear band; F8.1) and Focus Blur (dim background windows; F8.2)
 * — mutually exclusive surfaces the renderer draws from the `focus:state` event.
 *
 * This shell owns only the state subscription + mode routing; each mode's
 * geometry lives in its own shade component (Focus Read tracks `focus:cursor`,
 * Focus Blur tracks `focus:anchor`).
 */
export function FocusOverlayPage() {
	// The OS window is fully transparent — html/body must be too, or WebView2
	// paints an opaque page background behind the tint.
	useTransparentBody();
	const [state, setState] = useState<FocusState>(INACTIVE);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		void commands
			.focusActiveState()
			.then((next) => {
				if (!disposed) {
					setState(next);
				}
			})
			.catch(() => undefined);
		const unsubscribe = subscribeNativeEvent(events.focusState, (event) => {
			setState(event.payload);
		});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, []);

	return (
		<div className="h-dvh w-dvw overflow-hidden">
			<FocusReadShade active={state.read} />
			<FocusBlurShade active={state.blur} />
		</div>
	);
}
