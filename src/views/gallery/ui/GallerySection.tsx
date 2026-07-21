import type { ReactNode } from "react";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";

/**
 * One gallery chapter: anchor target + heading + description, with the live
 * components on an `ElevatedSurface` card (demonstrating surface stepping —
 * the card re-provides its lifted level, so every control inside elevates
 * from there exactly as it would in a real panel).
 */
export function GallerySection({
	children,
	description,
	id,
	title,
}: {
	children: ReactNode;
	description: string;
	id: string;
	title: string;
}) {
	return (
		<section className="scroll-mt-4 pt-10 first:pt-0" id={id}>
			<header className="flex flex-col gap-1">
				<h3 className="font-semibold text-foreground text-subtitle tracking-[-0.01em]">
					{title}
				</h3>
				<p className="max-w-2xl text-body-sm text-foreground-muted">
					{description}
				</p>
			</header>
			<ElevatedSurface className="mt-4 flex flex-col gap-6 px-5 py-5">
				{children}
			</ElevatedSurface>
		</section>
	);
}

/** A labelled cluster of components inside a section card. */
export function DemoRow({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="flex flex-col gap-2.5">
			<span className="font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]">
				{label}
			</span>
			<div className="flex flex-wrap items-center gap-3">{children}</div>
		</div>
	);
}
