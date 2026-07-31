import { afterEach, describe, expect, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { HotkeyRecorder } from "./HotkeyRecorder";

interface InvokeCall {
	args: Record<string, unknown> | undefined;
	command: string;
}

function installInvoke(
	handler: (
		command: string,
		args?: Record<string, unknown>,
	) => Promise<unknown>,
): void {
	const internals = (
		window as unknown as {
			__TAURI_INTERNALS__: {
				invoke: typeof handler;
			};
		}
	).__TAURI_INTERNALS__;
	internals.invoke = handler;
}

function renderRecorder(
	overrides: Partial<ComponentProps<typeof HotkeyRecorder>> = {},
) {
	return render(
		<IntlProvider>
			<HotkeyRecorder
				currentKey="F1"
				hotkeyId="brightnessUp"
				label="Increase brightness"
				onKeyRecorded={() => undefined}
				{...overrides}
			/>
		</IntlProvider>,
	);
}

afterEach(cleanup);

describe("HotkeyRecorder native binding lifecycle", () => {
	test("Stop cancels capture and restores the suspended binding", async () => {
		const calls: InvokeCall[] = [];
		installInvoke(async (command, args) => {
			calls.push({ command, args });
			return null;
		});
		renderRecorder();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Record shortcut for Increase brightness",
			}),
		);
		await waitFor(() =>
			expect(calls).toContainEqual({
				command: "hotkey_unregister",
				args: { id: "brightnessUp" },
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Stop recording for Increase brightness",
			}),
		);

		await waitFor(() =>
			expect(calls).toContainEqual({
				command: "hotkey_register",
				args: { accelerator: "F1", id: "brightnessUp" },
			}),
		);
	});

	test("unmounting during capture restores the suspended binding", async () => {
		const calls: InvokeCall[] = [];
		installInvoke(async (command, args) => {
			calls.push({ command, args });
			return null;
		});
		const view = renderRecorder();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Record shortcut for Increase brightness",
			}),
		);
		await screen.findByRole("button", {
			name: "Stop recording for Increase brightness",
		});
		view.unmount();

		await waitFor(() =>
			expect(calls).toContainEqual({
				command: "hotkey_register",
				args: { accelerator: "F1", id: "brightnessUp" },
			}),
		);
	});

	test("a cross-row conflict rolls back to the previous binding", async () => {
		const calls: InvokeCall[] = [];
		installInvoke(async (command, args) => {
			calls.push({ command, args });
			return null;
		});
		renderRecorder({
			forbiddenCombos: [{ combo: "F2", label: "Decrease brightness" }],
		});

		fireEvent.click(
			screen.getByRole("button", {
				name: "Record shortcut for Increase brightness",
			}),
		);
		await screen.findByRole("button", {
			name: "Stop recording for Increase brightness",
		});
		fireEvent.keyDown(window, { code: "F2", key: "F2" });

		expect((await screen.findByRole("alert")).textContent).toContain(
			"Conflicts with Decrease brightness (F2)",
		);
		await waitFor(() =>
			expect(calls).toContainEqual({
				command: "hotkey_register",
				args: { accelerator: "F1", id: "brightnessUp" },
			}),
		);
		expect(
			calls.some(
				(call) =>
					call.command === "hotkey_register" &&
					call.args?.["accelerator"] === "F2",
			),
		).toBe(false);
	});

	test("a backend rejection rolls back and does not commit the candidate", async () => {
		const calls: InvokeCall[] = [];
		const recorded: string[] = [];
		installInvoke(async (command, args) => {
			calls.push({ command, args });
			if (command === "hotkey_register" && args?.["accelerator"] === "F3") {
				const backendError: unknown = "F3 is already in use";
				throw backendError;
			}
			return null;
		});
		renderRecorder({ onKeyRecorded: (combo) => recorded.push(combo) });

		fireEvent.click(
			screen.getByRole("button", {
				name: "Record shortcut for Increase brightness",
			}),
		);
		await screen.findByRole("button", {
			name: "Stop recording for Increase brightness",
		});
		fireEvent.keyDown(window, { code: "F3", key: "F3" });

		expect((await screen.findByRole("alert")).textContent).toContain(
			"F3 is already in use",
		);
		await waitFor(() =>
			expect(calls).toContainEqual({
				command: "hotkey_register",
				args: { accelerator: "F1", id: "brightnessUp" },
			}),
		);
		expect(recorded).toEqual([]);
	});

	test("an unregister rejection keeps the old binding and never starts capture", async () => {
		installInvoke(async (command) => {
			if (command === "hotkey_unregister") {
				const backendError: unknown = "could not suspend F1";
				throw backendError;
			}
			return null;
		});
		renderRecorder();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Record shortcut for Increase brightness",
			}),
		);

		expect((await screen.findByRole("alert")).textContent).toContain(
			"could not suspend F1",
		);
		expect(
			screen.queryByRole("button", {
				name: "Stop recording for Increase brightness",
			}),
		).toBeNull();
	});
});
