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
import { MagicToolbarPage } from "@/views/magic-toolbar";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[magic-toolbar] #root element missing");
}

// The Magic Toolbar is a tiny transparent always-on-top strip — no RootLayout
// (opaque substrate) and no Tooltip provider.
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
								<MagicToolbarPage />
							</ErrorBoundary>
						</LazyMotion>
					</SurfaceProvider>
				</AppMotionConfig>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);
