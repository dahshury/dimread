import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

const REVEAL_TRANSITION_PROPERTIES = new Set([
	"filter",
	"opacity",
	"transform",
]);

function cssTimeToMs(value: string): number {
	const amount = Number.parseFloat(value);
	if (!Number.isFinite(amount)) {
		return 0;
	}
	return value.trim().endsWith("ms") ? amount : amount * 1000;
}

function hasRevealTransition(root: HTMLElement): boolean {
	return Array.from(root.querySelectorAll<HTMLElement>(".t-stagger-line")).some(
		(element) => {
			const style = getComputedStyle(element);
			const properties = style.transitionProperty
				.split(",")
				.map((value) => value.trim());
			const durations = style.transitionDuration.split(",");
			const delays = style.transitionDelay.split(",");

			return properties.some((property, index) => {
				if (property !== "all" && !REVEAL_TRANSITION_PROPERTIES.has(property)) {
					return false;
				}

				const duration = cssTimeToMs(
					durations[index % durations.length] ?? "0s",
				);
				const delay = cssTimeToMs(delays[index % delays.length] ?? "0s");
				return duration > 0 && duration + delay > 0;
			});
		},
	);
}

export function StaggerReveal({
	active,
	children,
	className,
	contentClassName,
	onComplete,
}: {
	active: boolean;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
	onComplete?: () => void;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const onCompleteRef = useRef(onComplete);

	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	useEffect(() => {
		if (!active) {
			return;
		}
		const root = rootRef.current;
		if (!root) {
			return;
		}

		const runningTransitions = new Map<EventTarget, Set<string>>();
		let completed = false;

		const complete = () => {
			if (completed || !root.classList.contains("t-stagger")) {
				return;
			}
			completed = true;
			onCompleteRef.current?.();
		};

		const isRevealEvent = (
			event: TransitionEvent,
		): event is TransitionEvent & { target: HTMLElement } => {
			const target = event.target;
			return (
				target instanceof HTMLElement &&
				target.classList.contains("t-stagger-line") &&
				REVEAL_TRANSITION_PROPERTIES.has(event.propertyName)
			);
		};

		const trackTransition = (event: TransitionEvent) => {
			if (!isRevealEvent(event)) {
				return;
			}
			const properties = runningTransitions.get(event.target) ?? new Set();
			properties.add(event.propertyName);
			runningTransitions.set(event.target, properties);
		};

		const settleTransition = (event: TransitionEvent) => {
			if (!isRevealEvent(event)) {
				return;
			}
			const properties = runningTransitions.get(event.target);
			if (!properties?.delete(event.propertyName)) {
				return;
			}
			if (properties.size === 0) {
				runningTransitions.delete(event.target);
			}
			if (runningTransitions.size === 0) {
				complete();
			}
		};

		root.addEventListener("transitionrun", trackTransition);
		root.addEventListener("transitionend", settleTransition);
		root.addEventListener("transitioncancel", settleTransition);
		root.classList.remove("is-hiding");
		root.classList.remove("is-shown");
		void root.offsetHeight;

		const frame = window.requestAnimationFrame(() => {
			root.classList.add("is-shown");
			if (!hasRevealTransition(root)) {
				complete();
			}
		});

		return () => {
			window.cancelAnimationFrame(frame);
			root.removeEventListener("transitionrun", trackTransition);
			root.removeEventListener("transitionend", settleTransition);
			root.removeEventListener("transitioncancel", settleTransition);
		};
	}, [active]);

	return (
		<div
			className={cn(active && "t-stagger", className)}
			data-live-entry-reveal={active ? "" : undefined}
			ref={rootRef}
		>
			<div className={cn(active && "t-stagger-line", contentClassName)}>
				{children}
			</div>
		</div>
	);
}
