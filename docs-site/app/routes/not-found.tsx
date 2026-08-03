import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Link } from "react-router";
import { Footer } from "@/components/footer";
import { IconArrowRight } from "@/components/icons";
import { Kbd } from "@/components/kbd";
import { baseOptions } from "@/lib/layout.shared";

export function meta() {
	return [{ title: "Not found — DimRead docs" }];
}

export default function NotFound() {
	return (
		<HomeLayout {...baseOptions()}>
			{/* Rendered as a route AND from the `/docs/*` error boundary. A route
			    `meta()` export does not run in the boundary case, so the title is
			    declared here too — React hoists it into <head> either way. */}
			<title>Not found — DimRead docs</title>
			{/* HomeLayout provides the <main> landmark; this is a plain div. */}
			<div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-24 text-center">
				<div aria-hidden="true" className="dim-aurora opacity-60" />
				<div className="relative z-10 flex flex-col items-center gap-5">
					<span className="dim-spectrum-text font-semibold text-6xl tracking-tight">
						404
					</span>
					<h1 className="font-semibold text-2xl tracking-tight">
						That page does not exist
					</h1>
					<p className="max-w-[46ch] text-fd-muted-foreground leading-relaxed">
						The link may be out of date. The documentation index is a good place
						to start — or press <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> to search.
					</p>
					<Link
						className="inline-flex items-center gap-2 rounded-full bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground text-sm no-underline"
						to="/docs"
					>
						Open the docs
						<IconArrowRight className="size-4" />
					</Link>
				</div>
			</div>
			<Footer />
		</HomeLayout>
	);
}
