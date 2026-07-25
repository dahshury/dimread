import { describe, expect, it } from "bun:test";
import type { OverlayNotification } from "@/bindings";
import { INITIAL_OVERLAY_STATE, overlayReducer } from "./notification-core";

function notification(
	overrides: Partial<OverlayNotification> = {},
): OverlayNotification {
	return {
		sequence: 1,
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

	it("replaces the visible notification (no queue)", () => {
		const first = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		const second = overlayReducer(first, {
			type: "notify",
			notification: notification({
				sequence: 2,
				message: "replaced",
				tone: "error",
			}),
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

	it("ignores stale dismiss events", () => {
		const first = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		const stale = overlayReducer(first, { type: "dismiss", sequence: 0 });
		expect(stale.visible).toBe(true);
	});

	it("dismiss hides but keeps content", () => {
		const first = overlayReducer(INITIAL_OVERLAY_STATE, {
			type: "notify",
			notification: notification(),
		});
		const dismissed = overlayReducer(first, { type: "dismiss", sequence: 2 });
		expect(dismissed.visible).toBe(false);
		expect(dismissed.notification?.message).toBe("hello");
		// Dismiss while hidden is a no-op.
		expect(overlayReducer(dismissed, { type: "dismiss", sequence: 2 })).toBe(
			dismissed,
		);
	});
});
