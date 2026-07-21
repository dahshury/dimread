import { PlayIcon, StopCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m as motion } from "motion/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupContent,
	InputGroupText,
} from "@/shared/ui/input-group";
import {
	type ForbiddenCombo,
	findConflict,
	formatCombo,
	isHintText,
	resolveDisplayText,
} from "../lib/hotkey-recorder-helpers";
import { useKeyRecorder } from "../model/use-key-recorder";

export interface HotkeyRecorderProps {
	currentKey: string;
	/**
	 * Combos this recorder must NOT collide with (equal / subset / superset all
	 * count). Conflicts are rejected with an inline error naming the other
	 * binding; empty / undefined disables the cross-hotkey check.
	 */
	forbiddenCombos?: readonly ForbiddenCombo[];
	/**
	 * Backend registration id (e.g. `"toggleMain"`). When set, recording
	 * SUSPENDS the live global binding (so pressing the current combo doesn't
	 * fire it mid-capture) and the recorded combo is validated + armed through
	 * `hotkey_register` BEFORE `onKeyRecorded` commits it — a rejected combo
	 * (invalid / already in use) surfaces inline and the previous binding is
	 * restored.
	 */
	hotkeyId?: string;
	onKeyRecorded: (key: string) => void;
}

const CHIP_BASE =
	"inline-flex h-6 items-center rounded-[6px] px-1.5 py-px text-[11px] leading-none font-medium";
const CHIP_RECORDING = "bg-error/15 text-error ring-1 ring-error/35";
const CHIP_HINT =
	"bg-transparent text-foreground-muted ring-0 italic font-normal";
// Decorative, aria-hidden separator glyph between key chips — a visual symbol,
// not translatable copy. Held in a constant so it isn't flagged as user-facing.
const PLUS_GLYPH = "＋";

function ComboParts({
	text,
	recording,
	isHint,
}: {
	text: string;
	recording: boolean;
	isHint: boolean;
}) {
	// Idle keycaps lift one step above the input-group's substrate so each cap
	// reads as its own surface. Called before the `isHint` early return to keep
	// the hook unconditional.
	const chipIdle = cn(
		surfaceBg(Math.min(useSurface() + 1, 8)),
		"text-foreground ring-1 ring-divider",
	);
	if (isHint) {
		return (
			<motion.span
				animate={{ opacity: 1, y: 0 }}
				className={`${CHIP_BASE} ${CHIP_HINT}`}
				initial={{ opacity: 0, y: 2 }}
				key="hint"
				transition={springs.moderate}
			>
				{text}
			</motion.span>
		);
	}
	const parts = text.split(" + ");
	const chipClass = recording ? CHIP_RECORDING : chipIdle;
	return (
		<span className="flex items-center gap-1.5">
			<AnimatePresence initial={false} mode="popLayout">
				{parts.map((part, i) => (
					<motion.span
						animate={{ opacity: 1, y: 0, scale: 1 }}
						className="flex items-center gap-1.5"
						exit={{ opacity: 0, y: -4, scale: 0.92 }}
						initial={{ opacity: 0, y: 4, scale: 0.92 }}
						key={`${part}-${i.toString()}`}
						transition={springs.fast}
					>
						{i > 0 && (
							<span
								aria-hidden
								className="select-none text-[10px] text-foreground-dim"
							>
								{PLUS_GLYPH}
							</span>
						)}
						<span className={`${CHIP_BASE} ${chipClass}`}>{part}</span>
					</motion.span>
				))}
			</AnimatePresence>
		</span>
	);
}

function RecordingBadge({ label }: { label: string }) {
	// Transform/opacity-only reveal (no `width` keyframes — animating layout
	// properties forces reflow every frame): the badge slides in from the
	// toggle button's edge and retracts the same way on exit.
	return (
		<motion.div
			animate={{ opacity: 1, x: 0, scale: 1 }}
			className="flex origin-right items-center gap-1.5 whitespace-nowrap"
			exit={{
				opacity: 0,
				x: 8,
				scale: 0.92,
				transition: springs.moderate.exit,
			}}
			initial={{ opacity: 0, x: 8, scale: 0.92 }}
			key="recording-badge"
			transition={springs.moderate}
		>
			<motion.span
				animate={{ opacity: [0.55, 1, 0.55], scale: [0.9, 1.1, 0.9] }}
				className="inline-block size-1.5 rounded-full bg-error"
				transition={{
					duration: 1.1,
					repeat: Number.POSITIVE_INFINITY,
					ease: "easeInOut",
				}}
			/>
			<InputGroupText className="text-error">{label}</InputGroupText>
		</motion.div>
	);
}

function ToggleIcon({ recording }: { recording: boolean }) {
	return (
		<AnimatePresence initial={false} mode="wait">
			<motion.span
				animate={{ opacity: 1, scale: 1, rotate: 0 }}
				className="inline-flex"
				exit={{ opacity: 0, scale: 0.6, rotate: recording ? -25 : 25 }}
				initial={{ opacity: 0, scale: 0.6, rotate: recording ? 25 : -25 }}
				key={recording ? "stop" : "play"}
				transition={springs.fast}
			>
				<HugeiconsIcon
					className="shrink-0"
					icon={recording ? StopCircleIcon : PlayIcon}
					size={16}
					strokeWidth={2.25}
				/>
			</motion.span>
		</AnimatePresence>
	);
}

function ErrorMessage({ message }: { message: string }) {
	// Inline below the recorder — `role="alert"` so screen readers announce
	// the rejection ("your last action failed") on next-tick paint.
	return (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			className="mt-1 text-[11px] text-error"
			initial={{ opacity: 0, y: -2 }}
			key="recorder-error"
			role="alert"
			transition={springs.moderate}
		>
			{message}
		</motion.div>
	);
}

/** Fire-and-forget backend registration used by the suspend/restore paths. */
function restoreBinding(hotkeyId: string | undefined, combo: string): void {
	if (!(hotkeyId && hasNativeRuntime()) || combo.trim().length === 0) {
		return;
	}
	void commands.hotkeyRegister(hotkeyId, combo).catch(() => undefined);
}

export function HotkeyRecorder({
	currentKey,
	forbiddenCombos,
	hotkeyId,
	onKeyRecorded,
}: HotkeyRecorderProps) {
	const t = useTranslations("hotkeys");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Gate the final commit: cross-hotkey conflicts are rejected locally, then
	// the backend validates + arms the combo (duplicate/invalid → typed error
	// string) BEFORE the parent persists it.
	const handleRecorded = (combo: string): void => {
		const conflict = findConflict(combo, forbiddenCombos);
		if (conflict) {
			setErrorMessage(
				t("conflictError", {
					other: conflict.label,
					combo: formatCombo(conflict.combo),
				}),
			);
			restoreBinding(hotkeyId, currentKey);
			return;
		}
		if (hotkeyId && hasNativeRuntime()) {
			void commands
				.hotkeyRegister(hotkeyId, combo)
				.then((result) => {
					if (result.status === "error") {
						setErrorMessage(result.error);
						restoreBinding(hotkeyId, currentKey);
						return;
					}
					setErrorMessage(null);
					onKeyRecorded(combo);
				})
				.catch((error: unknown) => {
					setErrorMessage(
						error instanceof Error ? error.message : String(error),
					);
					restoreBinding(hotkeyId, currentKey);
				});
			return;
		}
		setErrorMessage(null);
		onKeyRecorded(combo);
	};

	// Suspend the live binding while capturing; a cancelled / invalid-peak
	// recording restores it (a committed combo re-arms via hotkey_register in
	// handleRecorded — including the rejected-commit paths, which restore
	// explicitly after the backend answer).
	const handleRecordingChange = (
		nowRecording: boolean,
		committedCombo: string | null,
	): void => {
		if (!(hotkeyId && hasNativeRuntime())) {
			return;
		}
		if (nowRecording) {
			void commands.hotkeyUnregister(hotkeyId).catch(() => undefined);
			return;
		}
		if (committedCombo === null) {
			restoreBinding(hotkeyId, currentKey);
		}
	};

	const { recording, liveKeys, startRecording, stopRecording } = useKeyRecorder(
		{
			onKeyRecorded: handleRecorded,
			onRecordingChange: handleRecordingChange,
		},
	);

	const displayText = resolveDisplayText(
		recording,
		liveKeys,
		currentKey,
		t("pressKeys"),
		t("notSet"),
	);
	const isHint = isHintText(recording, liveKeys, currentKey);
	const onToggle = () => {
		if (recording) {
			stopRecording();
			return;
		}
		// Clearing the error on a fresh attempt prevents stale "conflicts with
		// X" text from outliving the next successful recording.
		setErrorMessage(null);
		startRecording();
	};
	const showError = !recording && errorMessage !== null;
	const tone = recording || showError ? "danger" : "default";
	const toggleLabel = recording ? t("stop") : t("record");

	return (
		<div className="w-full min-w-[260px] max-w-[420px]">
			<InputGroup tone={tone}>
				<InputGroupContent>
					<ComboParts
						isHint={isHint}
						recording={recording}
						text={displayText}
					/>
				</InputGroupContent>

				<InputGroupAddon align="inline-end">
					<AnimatePresence initial={false}>
						{recording && <RecordingBadge key="badge" label={t("recording")} />}
					</AnimatePresence>
					<motion.span
						className="inline-flex"
						transition={springs.fast}
						whileHover={{ scale: 1.06 }}
						whileTap={{ scale: 0.92 }}
					>
						<InputGroupButton
							aria-label={toggleLabel}
							onClick={onToggle}
							// Idle stays transparent so shortcut rows don't show a column
							// of filled play disks; recording keeps the red active tone.
							tone={recording ? "danger" : "ghost"}
						>
							<ToggleIcon recording={recording} />
						</InputGroupButton>
					</motion.span>
				</InputGroupAddon>
			</InputGroup>
			{/* Bare conditional (no AnimatePresence) so the alert unmounts
			    instantly when the user starts a new recording. */}
			{showError && <ErrorMessage message={errorMessage} />}
		</div>
	);
}
