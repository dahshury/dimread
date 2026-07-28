import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";

/**
 * `commands.updateCheck` is the hook's only collaborator. Mocking the generated
 * bindings module keeps the test off the IPC bridge while still exercising the
 * tauri-specta `Result` envelope the real command returns.
 */
let respond: () => Promise<unknown>;

mock.module("@/bindings", () => ({
	commands: {
		updateCheck: () => respond(),
	},
	events: {},
}));

const { useUpdateCheck } = await import("./use-update-check");

const OK_CHECK = {
	currentVersion: "0.0.2-alpha",
	downloadName: "DimRead.exe",
	downloadUrl: "https://example.test/DimRead.exe",
	latestVersion: "0.1.0",
	publishedAt: "2026-01-01T00:00:00Z",
	releaseUrl: "https://example.test/releases/v0.1.0",
	status: "updateAvailable",
};

/** `hasNativeRuntime()` is a pure read of this global — no module mock needed. */
function setNativeRuntime(present: boolean): void {
	const target = window as Window & { __TAURI_INTERNALS__?: unknown };
	if (present) {
		target.__TAURI_INTERNALS__ = {};
	} else {
		target.__TAURI_INTERNALS__ = undefined;
	}
}

describe("useUpdateCheck", () => {
	beforeEach(() => {
		setNativeRuntime(true);
		respond = () => Promise.resolve({ status: "ok", data: OK_CHECK });
	});

	afterEach(() => {
		setNativeRuntime(false);
	});

	test("starts idle and never checks on mount", async () => {
		let calls = 0;
		respond = () => {
			calls += 1;
			return Promise.resolve({ status: "ok", data: OK_CHECK });
		};

		const { result } = renderHook(() => useUpdateCheck());

		expect(result.current.state).toEqual({ phase: "idle" });
		expect(calls).toBe(0);
		expect(result.current.available).toBe(true);
	});

	test("reports the resolved check", async () => {
		const { result } = renderHook(() => useUpdateCheck());

		act(() => {
			result.current.check();
		});

		await waitFor(() => {
			expect(result.current.state.phase).toBe("result");
		});
		expect(result.current.state).toEqual({ phase: "result", check: OK_CHECK });
	});

	test("surfaces the backend's error message instead of swallowing it", async () => {
		respond = () =>
			Promise.resolve({
				status: "error",
				error: "GitHub rate limit reached — try again later",
			});

		const { result } = renderHook(() => useUpdateCheck());
		act(() => {
			result.current.check();
		});

		await waitFor(() => {
			expect(result.current.state.phase).toBe("error");
		});
		expect(result.current.state).toEqual({
			phase: "error",
			message: "GitHub rate limit reached — try again later",
		});
	});

	test("a thrown IPC failure becomes an error state, not an unhandled rejection", async () => {
		respond = () => Promise.reject(new Error("ipc closed"));

		const { result } = renderHook(() => useUpdateCheck());
		act(() => {
			result.current.check();
		});

		await waitFor(() => {
			expect(result.current.state.phase).toBe("error");
		});
		expect(result.current.state).toEqual({
			phase: "error",
			message: "ipc closed",
		});
	});

	test("a second press while one check is in flight is ignored", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		respond = () => {
			calls += 1;
			return new Promise((resolve) => {
				release = () => resolve({ status: "ok", data: OK_CHECK });
			});
		};

		const { result } = renderHook(() => useUpdateCheck());
		act(() => {
			result.current.check();
			result.current.check();
			result.current.check();
		});

		expect(calls).toBe(1);
		expect(result.current.state.phase).toBe("checking");

		await act(async () => {
			release?.();
			await Promise.resolve();
		});
		await waitFor(() => {
			expect(result.current.state.phase).toBe("result");
		});

		// …and the guard releases, so a follow-up check still works.
		respond = () => Promise.resolve({ status: "ok", data: OK_CHECK });
		act(() => {
			result.current.check();
		});
		await waitFor(() => {
			expect(result.current.state.phase).toBe("result");
		});
	});

	test("does nothing outside the desktop app", async () => {
		setNativeRuntime(false);
		let calls = 0;
		respond = () => {
			calls += 1;
			return Promise.resolve({ status: "ok", data: OK_CHECK });
		};

		const { result } = renderHook(() => useUpdateCheck());
		act(() => {
			result.current.check();
		});

		expect(result.current.available).toBe(false);
		expect(result.current.state).toEqual({ phase: "idle" });
		expect(calls).toBe(0);
	});
});
