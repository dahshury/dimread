import { StrictMode, Suspense } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { RootLayout } from "@/app/layouts/RootLayout";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { GalleryPage } from "@/views/gallery";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[gallery] #root element missing");
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<RootLayout>
			<Suspense fallback={null}>
				<GalleryPage />
			</Suspense>
		</RootLayout>
	</StrictMode>,
);
