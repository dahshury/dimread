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
import { useSettingsSync } from "@/entities/setting";
import { SurfaceProvider } from "@/shared/lib/surface";
import { SettingsPage } from "@/views/settings";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[settings] #root element missing");
}

/**
 * App-window bootstrap — this is the ROOT entry (`index.html`), because the
 * settings window IS the application: there is no separate main window.
 *
 * It does NOT mount RootLayout (whose shell paints an opaque `bg-surface-1` —
 * this window is transparent; the view paints its own rounded card). It still
 * needs the data hooks, above all `useSettingsSync`, which hydrates the local
 * settings cache from the backend store.
 */
function SettingsBootstrap() {
	useSettingsSync();
	return <SettingsPage />;
}

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
									<SettingsBootstrap />
								</ErrorBoundary>
							</LazyMotion>
						</SurfaceProvider>
					</Tooltip.Provider>
				</AppMotionConfig>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);
