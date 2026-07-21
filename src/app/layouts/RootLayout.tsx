import { Tooltip } from "@base-ui/react/tooltip";
import { domAnimation, LazyMotion, m } from "motion/react";
import type { ReactNode } from "react";
import { useSettingsSync } from "@/entities/setting";
import { springs } from "@/shared/lib/springs";
import { SurfaceProvider } from "@/shared/lib/surface";
import { AppMotionConfig } from "../providers/AppMotionConfig";
import { ErrorBoundary } from "../providers/ErrorBoundary";
import { IntlProvider } from "../providers/IntlProvider";

/**
 * Per-window provider stack: IntlProvider → MotionConfig (reduced-motion
 * aware) → Tooltip.Provider → SurfaceProvider(1) → LazyMotion (strict,
 * domAnimation) → noise-overlay shell. Every window entry composes this
 * around its view.
 */
export function RootLayout({ children }: { children: ReactNode }) {
	// Hydrate + live-sync settings at the window root so every window
	// converges on the backend snapshot.
	useSettingsSync();
	return (
		<IntlProvider>
			{/* Honors the OS prefers-reduced-motion setting app-wide, plus the
			    appearance.reducedMotion settings override. */}
			<AppMotionConfig>
				<Tooltip.Provider closeDelay={0} delay={400}>
					<SurfaceProvider value={1}>
						<LazyMotion features={domAnimation} strict>
							<m.div
								animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
								className="noise-overlay flex h-screen flex-col bg-surface-1"
								initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
								transition={springs.slow}
							>
								<main className="flex-1 overflow-hidden">
									<ErrorBoundary>{children}</ErrorBoundary>
								</main>
							</m.div>
						</LazyMotion>
					</SurfaceProvider>
				</Tooltip.Provider>
			</AppMotionConfig>
		</IntlProvider>
	);
}
