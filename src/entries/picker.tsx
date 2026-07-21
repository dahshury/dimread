import { Tooltip } from "@base-ui/react/tooltip";
import { domAnimation, LazyMotion } from "motion/react";
import { StrictMode, Suspense } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { AppMotionConfig } from "@/app/providers/AppMotionConfig";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { ErrorBoundary } from "@/app/providers/ErrorBoundary";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { SurfaceProvider } from "@/shared/lib/surface";
import { PickerPage } from "@/views/picker";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[picker] #root element missing");
}

// The picker window is a transparent full-workarea backdrop with an anchored
// panel — no RootLayout (its shell paints an opaque substrate).
renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<AppMotionConfig>
					<Tooltip.Provider closeDelay={0} delay={400}>
						<SurfaceProvider value={1}>
							<LazyMotion features={domAnimation} strict>
								<ErrorBoundary>
									<PickerPage />
								</ErrorBoundary>
							</LazyMotion>
						</SurfaceProvider>
					</Tooltip.Provider>
				</AppMotionConfig>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);
