import { Combobox } from "@base-ui/react/combobox";
import { Button as BaseButton } from "@base-ui/react/button";
import { ArrowDown01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceClasses } from "@/shared/lib/surface";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import {
	COMBOBOX_EMPTY_CLASS,
	ComboboxPopupShell,
	comboboxPopupClassName,
	optionMatchesQuery,
} from "@/shared/ui/combobox-base";
import { ScrollArea } from "@/shared/ui/scroll-area";
import {
	OptionBadge,
	type SelectOption,
	usePopupSurfaceLevels,
} from "@/shared/ui/select";
import { Tooltip } from "@/shared/ui/tooltip";
import "@/shared/ui/searchable-select/searchable-select.css";
import {
	COLLAPSED_SELECTION_THRESHOLD,
	mergeSelectAll,
	summarizeSelection,
	toggleSelection,
} from "./multi-combobox-logic";

export type MultiComboboxOption<T extends string = string> = SelectOption & {
	id: T;
};

export interface MultiComboboxProps<T extends string = string> {
	ariaLabel: string;
	/** Label for the bulk clear-selection action. Omit (with `selectAllLabel`)
	 *  to hide the bulk-action row. */
	clearAllLabel?: string | undefined;
	disabled?: boolean;
	emptyLabel: string;
	onChange: (value: T[]) => void;
	options: readonly MultiComboboxOption<T>[];
	placeholder: string;
	/** aria-label for a chip's remove button, e.g. "Remove English". */
	removeLabel: (item: string) => string;
	/** Label for the bulk select-all action (selects every VISIBLE option —
	 *  additive over the current selection when a search filter is active). */
	selectAllLabel?: string | undefined;
	selectedCountLabel: (count: number) => string;
	/** Heading shown above the selected-item summary inside the open popup. */
	selectedHeading: string;
	value: readonly T[];
}

function SelectedChip({
	label,
	onRemove,
	removeLabel,
}: {
	label: string;
	onRemove: () => void;
	removeLabel: (item: string) => string;
}) {
	return (
		<span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-1 py-0.5 pr-0.5 pl-1.5 text-body-sm text-foreground">
			<span className="truncate">{label}</span>
			<button
				aria-label={removeLabel(label)}
				className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim transition-colors hover:bg-error-dim hover:text-error"
				// Keep focus on the combobox input so removing a chip doesn't
				// blur/close the popup; the click still toggles the item off.
				onMouseDown={(event) => event.preventDefault()}
				onClick={onRemove}
				type="button"
			>
				<HugeiconsIcon icon={Cancel01Icon} size={11} />
			</button>
		</span>
	);
}

function SelectedCountChip({
	label,
	tooltip,
}: {
	label: string;
	tooltip: string;
}) {
	return (
		<Tooltip content={tooltip} side="bottom">
			<span className="inline-flex h-6 min-w-9 items-center justify-center rounded-md border border-border bg-surface-1 px-2 font-mono font-semibold text-body-sm text-foreground">
				{label}
			</span>
		</Tooltip>
	);
}

/** Small text button for the popup's select-all / clear bulk actions. */
function BulkActionButton({
	disabled,
	label,
	onClick,
}: {
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<BaseButton
			className={cn(
				"cursor-pointer rounded-xs border-none bg-transparent px-1 py-0.5 font-medium text-[11px] text-foreground-secondary outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-accent",
				disabled &&
					"cursor-not-allowed opacity-40 hover:text-foreground-secondary",
			)}
			disabled={disabled}
			// Keep focus on the combobox input so the popup stays open.
			onMouseDown={(event) => event.preventDefault()}
			onClick={onClick}
			type="button"
		>
			{label}
		</BaseButton>
	);
}

/**
 * Multi-select combobox (genericized from WinSTT's language picker): a search
 * input trigger whose closed state summarizes the selection (labels, then a
 * count chip past {@link COLLAPSED_SELECTION_THRESHOLD}), over a checkbox
 * option list with removable selection chips and optional select-all / clear
 * bulk actions pinned inside the popup.
 */
export function MultiCombobox<T extends string>({
	ariaLabel,
	clearAllLabel,
	disabled = false,
	emptyLabel,
	onChange,
	options,
	placeholder,
	removeLabel,
	selectAllLabel,
	selectedCountLabel,
	selectedHeading,
	value,
}: MultiComboboxProps<T>) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const selected = new Set(value);
	const visibleOptions = options.filter((option) =>
		optionMatchesQuery(option, query),
	);
	// Selected chips reflect the full selection in selection order, independent
	// of the search query, so the summary always shows every chosen item.
	const selectedOptions = value
		.map((id) => options.find((option) => option.id === id))
		.filter((option): option is MultiComboboxOption<T> => Boolean(option));
	const selectedLabels = selectedOptions.map((option) => option.label);
	const checkedIndices = new Set<number>();
	visibleOptions.forEach((option, index) => {
		if (selected.has(option.id)) {
			checkedIndices.add(index);
		}
	});

	const {
		triggerLevel: inputLevel,
		popupLevel,
		popupShadow,
	} = usePopupSurfaceLevels({ selfElevate: false });
	const popupBg = surfaceBg(popupLevel);
	const closedDisplay = summarizeSelection(
		selectedLabels,
		selectedCountLabel,
		placeholder,
	);
	const closedTooltip =
		!open && selectedLabels.length >= COLLAPSED_SELECTION_THRESHOLD
			? selectedLabels.join("\n")
			: undefined;
	const selectedTooltip = selectedLabels.join("\n");
	const selectedSummaryCollapsed =
		selectedLabels.length >= COLLAPSED_SELECTION_THRESHOLD;

	const toggleOption = (id: T): void => {
		onChange(toggleSelection(value, id));
	};

	const showBulkActions = Boolean(selectAllLabel || clearAllLabel);
	const allVisibleSelected =
		visibleOptions.length > 0 &&
		visibleOptions.every((option) => selected.has(option.id));

	const closedTrigger = (
		<div className="relative isolate flex w-full items-center">
			<Combobox.Input
				aria-label={ariaLabel}
				className={cn(
					`flex h-8 w-full items-center rounded-lg ${surfaceClasses(inputLevel)} pr-7 pl-2.5 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1`,
					disabled && "cursor-not-allowed opacity-40",
				)}
				onClick={() => {
					if (!disabled) {
						setOpen(true);
					}
				}}
				placeholder={placeholder}
			/>
			<Combobox.Trigger
				aria-label={ariaLabel}
				className={cn(
					"absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim",
					disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
				)}
			>
				<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
			</Combobox.Trigger>
		</div>
	);

	return (
		<Combobox.Root
			disabled={disabled}
			filter={null}
			inputValue={open ? query : closedDisplay}
			items={[]}
			onInputValueChange={setQuery}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setQuery("");
				}
			}}
			open={open}
			value={null}
		>
			{closedTooltip ? (
				<Tooltip content={closedTooltip} side="top">
					{closedTrigger}
				</Tooltip>
			) : (
				closedTrigger
			)}

			<ComboboxPopupShell popupLevel={popupLevel}>
				<Combobox.Popup
					className={comboboxPopupClassName(
						popupLevel,
						popupShadow,
						"searchable-select-popup relative overflow-hidden",
					)}
				>
					<ScrollArea
						rubberBandOnTouch
						verticalOnly
						verticalScrollbarClassName="my-1 me-1"
						viewportClassName="h-auto py-1 [max-height:min(16rem,var(--available-height))]"
					>
						{selectedOptions.length > 0 || showBulkActions ? (
							<div
								className={cn(
									"sticky top-0 z-raised mb-1 border-divider border-b px-2 pt-1 pb-2",
									popupBg,
								)}
							>
								<div className="flex items-center justify-between gap-2 px-0.5 pb-1">
									<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-wider">
										{selectedHeading}
									</span>
									{showBulkActions ? (
										<span className="flex shrink-0 items-center gap-1.5">
											{selectAllLabel ? (
												<BulkActionButton
													disabled={disabled || allVisibleSelected}
													label={selectAllLabel}
													onClick={() =>
														onChange(
															mergeSelectAll(
																value,
																visibleOptions.map((option) => option.id),
															),
														)
													}
												/>
											) : null}
											{clearAllLabel ? (
												<BulkActionButton
													disabled={disabled || value.length === 0}
													label={clearAllLabel}
													onClick={() => onChange([])}
												/>
											) : null}
										</span>
									) : null}
								</div>
								{selectedOptions.length > 0 ? (
									<div className="flex max-h-[4.5rem] flex-wrap gap-1 overflow-y-auto">
										{selectedSummaryCollapsed ? (
											<SelectedCountChip
												label={selectedCountLabel(selectedLabels.length)}
												tooltip={selectedTooltip}
											/>
										) : (
											selectedOptions.map((option) => (
												<SelectedChip
													key={option.id}
													label={option.label}
													onRemove={() => toggleOption(option.id)}
													removeLabel={removeLabel}
												/>
											))
										)}
									</div>
								) : null}
							</div>
						) : null}
						{visibleOptions.length === 0 ? (
							<div className={COMBOBOX_EMPTY_CLASS}>{emptyLabel}</div>
						) : (
							<CheckboxGroup
								checkedIndices={checkedIndices}
								className="w-full px-1"
							>
								{visibleOptions.map((option, index) => {
									const checked = selected.has(option.id);
									return (
										<CheckboxItem
											checked={checked}
											className="py-2"
											index={index}
											key={option.id}
											label={option.label}
											leading={
												option.badge ? (
													<OptionBadge text={option.badge} />
												) : null
											}
											onToggle={() => toggleOption(option.id)}
										/>
									);
								})}
							</CheckboxGroup>
						)}
					</ScrollArea>
				</Combobox.Popup>
			</ComboboxPopupShell>
		</Combobox.Root>
	);
}
