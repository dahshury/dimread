import { domAnimation, LazyMotion } from "motion/react";
import { StrictMode, Suspense } from "react";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { AppMotionConfig } from "@/app/providers/AppMotionConfig";
import { ErrorBoundary } from "@/app/providers/ErrorBoundary";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { SurfaceProvider } from "@/shared/lib/surface";
import { FocusOverlayPage } from "@/views/focus-overlay";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[focus-overlay] #root element missing");
}

// The focus overlay is a transparent, click-through tint spanning the whole
// virtual screen — no RootLayout (its shell paints an opaque substrate) and no
// Tooltip provider (nothing is hoverable in a click-through window).
renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<AppMotionConfig>
					<SurfaceProvider value={1}>
						<LazyMotion features={domAnimation} strict>
							<ErrorBoundary>
								<FocusOverlayPage />
							</ErrorBoundary>
						</LazyMotion>
					</SurfaceProvider>
				</AppMotionConfig>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);
