import { useState } from "react";

/**
 * The classic controlled/uncontrolled state bridge: when `value` is provided
 * the component is CONTROLLED (internal state is ignored and every change is
 * only reported through `onChange` — the owner decides whether it lands);
 * otherwise the hook owns the state, seeded from `defaultValue`, and still
 * reports changes. Lets a component expose both APIs from one code path
 * (ItemPicker selection/favorites, ModeSwitch value).
 */
export function useControllableState<T>(
	value: T | undefined,
	defaultValue: T,
	onChange?: ((next: T) => void) | undefined,
): [T, (next: T) => void] {
	const [internal, setInternal] = useState<T>(defaultValue);
	const isControlled = value !== undefined;
	const current = isControlled ? value : internal;
	// No manual useCallback: React Compiler (wired in the build) memoizes this
	// automatically, and no consumer depends on referential stability in tests.
	const setValue = (next: T) => {
		if (!isControlled) {
			setInternal(next);
		}
		onChange?.(next);
	};
	return [current, setValue];
}
