import { Tooltip } from "@base-ui/react/tooltip";
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
import { TrayMenuPage } from "@/views/tray-menu";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[tray-menu] #root element missing");
}

// The tray flyout is a transparent window sized to its panel — no RootLayout
// (its shell paints an opaque substrate over the whole window).
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
									<TrayMenuPage />
								</ErrorBoundary>
							</LazyMotion>
						</SurfaceProvider>
					</Tooltip.Provider>
				</AppMotionConfig>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);
