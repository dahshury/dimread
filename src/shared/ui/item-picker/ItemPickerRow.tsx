import { Button as BaseButton } from "@base-ui/react/button";
import { StarIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Badge } from "@/shared/ui/badge";
import { Tooltip } from "@/shared/ui/tooltip";
import type { ItemPickerItem } from "./item-picker-types";

export interface ItemPickerRowProps {
	/** Keyboard-highlighted (aria-activedescendant target). */
	active: boolean;
	favorite: boolean;
	favoriteLabel: string;
	id: string;
	item: ItemPickerItem;
	onHover: () => void;
	onSelect: (id: string) => void;
	/** Omitted = favorites disabled (no star column). */
	onToggleFavorite: ((id: string) => void) | undefined;
	selected: boolean;
}

/**
 * One pickable row: icon + title (+ muted subtitle) + badges + favorite star +
 * selected checkmark, in the muted fluid-functionalism vocabulary of WinSTT's
 * picker rows. A `role="option"` DIV (not a <button>) because the row carries
 * a nested favorite <button>, and a button may not legally contain another.
 * Keyboard interaction lives on the picker's search input (combobox pattern);
 * the row itself only reacts to pointer input.
 */
export function ItemPickerRow({
	active,
	favorite,
	favoriteLabel,
	id,
	item,
	onHover,
	onSelect,
	onToggleFavorite,
	selected,
}: ItemPickerRowProps) {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 1, 8);
	const selectedLevel = Math.min(substrate + 2, 8);
	return (
		// react-doctor-disable-next-line react-doctor/no-static-element-interactions -- role="option" row in the combobox pattern: keyboard activation is owned by the picker's search input (ArrowUp/Down + Enter via aria-activedescendant); the row only mirrors pointer input.
		// react-doctor-disable-next-line react-doctor/click-events-have-key-events -- same combobox pattern: Enter/Space are handled by the search input, not the option rows.
		<div
			aria-selected={selected}
			className={cn(
				"group/row mx-1.5 flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-[7px] text-body text-foreground leading-normal outline-none transition-colors",
				surfaceHoverBg(hoverLevel),
				active && surfaceBg(hoverLevel),
				selected &&
					cn(
						"font-medium ring-1 ring-foreground/[0.06] ring-inset",
						surfaceBg(selectedLevel),
					),
			)}
			data-active={active || undefined}
			id={id}
			onClick={() => onSelect(item.id)}
			onMouseMove={onHover}
			role="option"
			// Programmatically focusable only: the roving highlight lives on the
			// search input (aria-activedescendant), so rows stay out of tab order.
			tabIndex={-1}
		>
			{item.icon ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					icon={item.icon}
					size={15}
					strokeWidth={selected ? 2 : 1.5}
				/>
			) : null}
			<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
				<span className="min-w-0 truncate">{item.title}</span>
				{item.subtitle ? (
					<span className="min-w-0 truncate text-[11px] text-foreground-muted">
						{item.subtitle}
					</span>
				) : null}
			</span>
			{item.badges?.map((badge) => (
				<Badge className="shrink-0 font-mono" key={badge} variant="outline">
					{badge}
				</Badge>
			))}
			{onToggleFavorite ? (
				<Tooltip content={favoriteLabel} side="top">
					<BaseButton
						aria-label={favoriteLabel}
						aria-pressed={favorite}
						className={cn(
							"flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent",
							favorite
								? "text-warning"
								: "text-foreground-dim opacity-0 hover:text-foreground-secondary focus-visible:opacity-100 group-hover/row:opacity-100",
						)}
						onClick={(event) => {
							event.stopPropagation();
							onToggleFavorite(item.id);
						}}
						type="button"
					>
						<HugeiconsIcon
							fill={favorite ? "currentColor" : "none"}
							icon={StarIcon}
							size={13}
						/>
					</BaseButton>
				</Tooltip>
			) : null}
			<span aria-hidden="true" className="flex w-4 shrink-0 justify-center">
				{selected ? (
					<HugeiconsIcon
						className="text-foreground"
						icon={Tick02Icon}
						size={14}
						strokeWidth={2}
					/>
				) : null}
			</span>
		</div>
	);
}
