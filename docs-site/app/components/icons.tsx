import type { SVGProps } from "react";

/**
 * The site's icon set, hand-drawn as inline SVG.
 *
 * The app draws its own UI with HugeIcons, but pulling a 2 MB icon package
 * into a static docs site to render fifteen glyphs is not a trade worth
 * making — and the sidebar needs them to be one visual family with the
 * spectrum marks, not merely "an icon font". Everything here is a 24-grid,
 * 1.6-weight stroke except the three platform marks, which are silhouettes
 * because that is how those three logos are recognised.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Stroke({ children, ...props }: IconProps) {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="1em"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={1.6}
			viewBox="0 0 24 24"
			width="1em"
			{...props}
		>
			{children}
		</svg>
	);
}

/* ── Documentation sections ─────────────────────────────────────────── */

export function IconStart(props: IconProps) {
	return (
		<Stroke {...props}>
			<path d="M5 19c-1.2-3 .3-7.6 3.4-10.7C11 5.7 15 4.4 18.6 4.9c.5 3.6-.8 7.6-3.4 10.2C12.1 18.2 8 19.7 5 19Z" />
			<circle cx="14.2" cy="9.8" r="1.7" />
			<path d="M8.6 15.4 5.4 18.6M7.7 12.1 4.9 12A4 4 0 0 1 8 8.6M11.9 16.3l.1 2.8a4 4 0 0 0 3.4-3.1" />
		</Stroke>
	);
}

export function IconDisplay(props: IconProps) {
	return (
		<Stroke {...props}>
			<circle cx="12" cy="12" r="3.8" />
			<path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M18.4 5.6l-1.3 1.3M6.9 17.1l-1.3 1.3" />
		</Stroke>
	);
}

export function IconSchedule(props: IconProps) {
	return (
		<Stroke {...props}>
			<circle cx="12" cy="12" r="8.6" />
			<path d="M12 7.2V12l3.1 2" />
		</Stroke>
	);
}

export function IconRules(props: IconProps) {
	return (
		<Stroke {...props}>
			<path d="M3.6 5.2h16.8l-6.5 7.6v5.6l-3.8 2.2v-7.8L3.6 5.2Z" />
		</Stroke>
	);
}

export function IconEffects(props: IconProps) {
	return (
		<Stroke {...props}>
			<path d="M12 3.2 21 8l-9 4.8L3 8l9-4.8Z" />
			<path d="m3 12.5 9 4.8 9-4.8M3 16.6l9 4.8 9-4.8" />
		</Stroke>
	);
}

export function IconHotkeys(props: IconProps) {
	return (
		<Stroke {...props}>
			<rect height="12.4" rx="2.4" width="19.2" x="2.4" y="5.8" />
			<path d="M6.4 9.6h.01M9.6 9.6h.01M12.8 9.6h.01M16 9.6h.01M6.4 14.4h11.2" />
		</Stroke>
	);
}

export function IconTray(props: IconProps) {
	return (
		<Stroke {...props}>
			<rect height="15.6" rx="2.4" width="18.4" x="2.8" y="4.2" />
			<path d="M2.8 14.6h18.4M6.6 17.4h.01M9.8 17.4h.01M13 17.4h.01" />
		</Stroke>
	);
}

export function IconGeneral(props: IconProps) {
	return (
		<Stroke {...props}>
			<circle cx="12" cy="12" r="2.9" />
			<path d="M19.3 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a1.9 1.9 0 1 1 0-3.8h.2A1.6 1.6 0 0 0 4.7 7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 2.7-1.1v-.3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.3 1.2Z" />
		</Stroke>
	);
}

export function IconDiagnostics(props: IconProps) {
	return (
		<Stroke {...props}>
			<path d="M2.8 12.4h4l2.4-6.6 4.4 12.4 2.4-5.8h4.6" />
		</Stroke>
	);
}

export function IconTrouble(props: IconProps) {
	return (
		<Stroke {...props}>
			<path d="M14.4 6.2a3.9 3.9 0 0 0 5 5l-9 9a2.7 2.7 0 0 1-3.8-3.8l9-9Z" />
			<path d="m5.4 5.4 2 2M4 9.4l2.6-.6" />
		</Stroke>
	);
}

export function IconFaq(props: IconProps) {
	return (
		<Stroke {...props}>
			<circle cx="12" cy="12" r="8.6" />
			<path d="M9.7 9.5a2.4 2.4 0 0 1 4.6.8c0 1.6-2.3 2.4-2.3 2.4M12 16.4h.01" />
		</Stroke>
	);
}

export function IconAbout(props: IconProps) {
	return (
		<Stroke {...props}>
			<circle cx="12" cy="12" r="8.6" />
			<path d="M12 11v5.4M12 7.8h.01" />
		</Stroke>
	);
}

/* ── UI ─────────────────────────────────────────────────────────────── */

export function IconArrowRight(props: IconProps) {
	return (
		<Stroke {...props}>
			<path d="M4.4 12h15.2M13.4 5.8 19.6 12l-6.2 6.2" />
		</Stroke>
	);
}

export function IconDownload(props: IconProps) {
	return (
		<Stroke {...props}>
			<path d="M12 3.6v11.2M7.4 10.6 12 15.2l4.6-4.6M4 18.4h16" />
		</Stroke>
	);
}

/* ── Platforms ──────────────────────────────────────────────────────── */

export function IconWindows(props: IconProps) {
	return (
		<svg
			aria-hidden="true"
			fill="currentColor"
			height="1em"
			viewBox="0 0 24 24"
			width="1em"
			{...props}
		>
			<path d="M3 5.7 10.4 4.7v7.1H3V5.7Zm8.6-1.2L21 3.2v8.6h-9.4V4.5ZM3 12.9h7.4V20L3 19V12.9Zm8.6 0H21v8.6l-9.4-1.3v-7.3Z" />
		</svg>
	);
}

export function IconApple(props: IconProps) {
	return (
		<svg
			aria-hidden="true"
			fill="currentColor"
			height="1em"
			viewBox="0 0 24 24"
			width="1em"
			{...props}
		>
			<path d="M16.4 1.4c0 1.1-.4 2.2-1.2 3-.9 1-2 1.5-3.1 1.4-.1-1.1.4-2.2 1.2-3 .9-.9 2.2-1.5 3.1-1.4ZM20.9 17.1c-.5 1.2-.8 1.7-1.4 2.7-.9 1.5-2.2 3.2-3.8 3.3-1.4 0-1.7-.9-3.6-.9s-2.3.9-3.7.9c-1.6 0-2.8-1.6-3.7-3-2.5-4-2.8-8.6-1.2-11.1C4.6 7.3 6.3 6.2 8 6.2c1.7 0 2.7.9 4.1.9 1.4 0 2.2-.9 4.1-.9 1.5 0 3 .8 4.1 2.2-3.6 2-3 7.1.6 8.7Z" />
		</svg>
	);
}

export function IconLinux(props: IconProps) {
	return (
		<svg
			aria-hidden="true"
			height="1em"
			viewBox="0 0 24 24"
			width="1em"
			{...props}
		>
			<path
				d="M12 2.1c-2.5 0-4 1.9-4 4.5 0 .9.1 1.5.1 2.1 0 .8-.4 1.4-1.1 2.4C5.7 12.8 4.3 15.1 4.3 17c0 1.2.6 2 1.6 2 .6 0 1.1-.3 1.4-.9.4 2 2.3 3.1 4.7 3.1s4.3-1.1 4.7-3.1c.3.6.8.9 1.4.9 1 0 1.6-.8 1.6-2 0-1.9-1.4-4.2-2.7-5.9-.7-1-1.1-1.6-1.1-2.4 0-.6.1-1.2.1-2.1 0-2.6-1.5-4.5-4-4.5Z"
				fill="currentColor"
			/>
			<ellipse
				cx="10.3"
				cy="7.4"
				fill="var(--color-fd-background)"
				rx="1"
				ry="1.3"
			/>
			<ellipse
				cx="13.7"
				cy="7.4"
				fill="var(--color-fd-background)"
				rx="1"
				ry="1.3"
			/>
			<circle cx="10.4" cy="7.6" fill="currentColor" r=".55" />
			<circle cx="13.6" cy="7.6" fill="currentColor" r=".55" />
			<path
				d="M12 8.9c1 0 1.8.6 1.8 1.1s-.8 1.1-1.8 1.1-1.8-.6-1.8-1.1.8-1.1 1.8-1.1Z"
				fill="var(--color-dim-warm)"
			/>
		</svg>
	);
}
