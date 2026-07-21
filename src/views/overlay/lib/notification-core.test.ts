import { describe, expect, it } from "bun:test";
import type { OverlayNotification } from "@/bindings";
import {
	INITIAL_OVERLAY_STATE,
	overlayReducer,
	sameNotification,
} from "./notification-core";

function notification(
	overrides: Partial<OverlayNotification> = {},
): OverlayNotification {
	return {
		title: null,
		message: "hello",
		tone: "neutral",
		durationMs: 4000,
		...overrides,
	};
}

describe("overlayReducer", () => {
	it("shows a notification and bumps the generation", () => {
		const next = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		expect(next.visible).toBe(true);
		expect(next.generation).toBe(1);
		expect(next.notification?.message).toBe("hello");
	});

	it("replaces the visible notification (no queue) and restarts the clock", () => {
		const first = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		const second = overlayReducer(first, {
			type: "notify",
			notification: notification({ message: "replaced", tone: "error" }),
		});
		expect(second.visible).toBe(true);
		expect(second.notification?.message).toBe("replaced");
		expect(second.generation).toBe(2);
	});

	it("ignores duplicate deliveries of the visible notification", () => {
		const first = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		const dup = overlayReducer(first, {
			type: "notify",
			notification: notification(),
		});
		expect(dup).toBe(first);
	});

	it("expires only the current generation", () => {
		const first = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		const stale = overlayReducer(first, { type: "expired", generation: 0 });
		expect(stale.visible).toBe(true);

		const expired = overlayReducer(first, {
			type: "expired",
			generation: first.generation,
		});
		expect(expired.visible).toBe(false);
		// Content stays for the exit render.
		expect(expired.notification?.message).toBe("hello");
	});

	it("dismiss hides but keeps content and cancels pending expiry", () => {
		const first = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		const dismissed = overlayReducer(first, { type: "dismiss" });
		expect(dismissed.visible).toBe(false);
		expect(dismissed.notification?.message).toBe("hello");
		// The generation moved on: the old expiry is now a no-op.
		const after = overlayReducer(dismissed, {
			type: "expired",
			generation: first.generation,
		});
		expect(after).toBe(dismissed);

		// Dismiss while hidden is a no-op.
		expect(overlayReducer(dismissed, { type: "dismiss" })).toBe(dismissed);
	});
});

describe("sameNotification", () => {
	it("compares every displayed field", () => {
		expect(sameNotification(notification(), notification())).toBe(true);
		expect(
			sameNotification(notification(), notification({ tone: "success" })),
		).toBe(false);
		expect(
			sameNotification(notification(), notification({ title: "Hi" })),
		).toBe(false);
		expect(sameNotification(null, notification())).toBe(false);
	});
});
