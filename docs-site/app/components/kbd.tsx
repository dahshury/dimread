import type { ReactNode } from "react";

/**
 * A key cap. `<Kbd>Ctrl</Kbd>` in prose, or `<Combo keys="Ctrl+Alt+F" />` for a
 * whole accelerator written the way DimRead's own hotkey recorder writes it.
 *
 * DimRead is a hotkey-driven tray app, so shortcuts appear in running prose far
 * too often to leave as bare inline code.
 */
export function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="inline-flex min-w-[1.6em] items-center justify-center rounded-[5px] border border-fd-border border-b-2 bg-fd-muted px-1.5 py-0.5 font-medium font-mono text-[0.8em] text-fd-foreground leading-normal">
			{children}
		</kbd>
	);
}

export function Combo({ keys }: { keys: string }) {
	const parts = keys.split("+").map((part) => part.trim());
	return (
		<span className="inline-flex items-center gap-1 whitespace-nowrap">
			{parts.map((part, index) => (
				// Accelerators are short and fixed, so part+index is a stable key.
				<span
					className="inline-flex items-center gap-1"
					key={`${part}-${index}`}
				>
					{index > 0 ? (
						<span
							aria-hidden="true"
							className="text-fd-muted-foreground text-xs"
						>
							+
						</span>
					) : null}
					<Kbd>{part}</Kbd>
				</span>
			))}
		</span>
	);
}
