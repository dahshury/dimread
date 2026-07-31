import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	flushPendingSettings,
	getSettingsStoreState,
	useSettingsStore,
} from "@/entities/setting";
import { type HotkeyId, HOTKEY_ROW_ORDER } from "@/features/hotkey-actions";
import { HotkeysPanel } from "./HotkeysPanel";

const EXPECTED_LABELS = [
	"Increase brightness",
	"Decrease brightness",
	"Increase colour temperature",
	"Decrease colour temperature",
	"Toggle blue-light filter",
	"Toggle Reading mode",
	"Toggle Editing mode",
	"Show / hide DimRead",
	"Toggle Focus Read",
	"Toggle Focus Blur",
	"Toggle window dark (MagicX)",
	"Toggle window grayscale (MagicX)",
] as const;

function renderPanel() {
	return render(
		<IntlProvider>
			<HotkeysPanel />
		</IntlProvider>,
	);
}

function bindEveryRow(): void {
	const bindings = Object.fromEntries(
		HOTKEY_ROW_ORDER.map((id, index) => [id, `F${String(index + 1)}`]),
	) as Record<HotkeyId, string>;
	getSettingsStoreState().updateHotkeysSettings(bindings);
}

afterEach(cleanup);

describe("HotkeysPanel", () => {
	beforeEach(() => {
		getSettingsStoreState().resetSettings();
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
	});

	test("renders all 12 rows with row-specific Record, Stop, and Clear names", () => {
		expect(HOTKEY_ROW_ORDER).toHaveLength(12);
		bindEveryRow();
		renderPanel();

		for (const label of EXPECTED_LABELS) {
			const record = screen.getByRole("button", {
				name: `Record shortcut for ${label}`,
			});
			expect(
				screen.getByRole("button", { name: `Clear shortcut for ${label}` }),
			).toBeDefined();
			fireEvent.click(record);
			const stop = screen.getByRole("button", {
				name: `Stop recording for ${label}`,
			});
			expect(stop).toBeDefined();
			fireEvent.click(stop);
		}
	});

	test("Clear unregisters the row and clears its persisted value", async () => {
		getSettingsStoreState().updateHotkeysSettings({ brightnessUp: "F2" });
		const calls: Array<{
			args: Record<string, unknown> | undefined;
			command: string;
		}> = [];
		const internals = {
			invoke: async (command: string, args?: Record<string, unknown>) => {
				calls.push({ command, args });
				if (command === "hotkey_list") {
					return [];
				}
				if (command === "settings_save") {
					return {
						revision: 1,
						settings: useSettingsStore.getState().settings,
					};
				}
				return null;
			},
			transformCallback: () => 1,
		};
		(
			window as unknown as { __TAURI_INTERNALS__: typeof internals }
		).__TAURI_INTERNALS__ = internals;
		renderPanel();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Clear shortcut for Increase brightness",
			}),
		);
		await waitFor(() =>
			expect(calls).toContainEqual({
				command: "hotkey_unregister",
				args: { id: "brightnessUp" },
			}),
		);
		await waitFor(() =>
			expect(useSettingsStore.getState().settings.hotkeys.brightnessUp).toBe(
				"",
			),
		);
		await flushPendingSettings();
	});
});
