import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { useSettingsStore } from "@/entities/setting";

/**
 * App-wide motion policy: `reducedMotion="user"` honors the OS preference,
 * and the `appearance.reducedMotion` setting force-reduces JS-driven motion
 * regardless of the OS (the demo wiring for that settings row). CSS-only
 * transitions still follow the OS media query.
 */
export function AppMotionConfig({ children }: { children: ReactNode }) {
	const forceReduced = useSettingsStore(
		(s) => s.settings.appearance.reducedMotion,
	);
	return (
		<MotionConfig reducedMotion={forceReduced ? "always" : "user"}>
			{children}
		</MotionConfig>
	);
}
