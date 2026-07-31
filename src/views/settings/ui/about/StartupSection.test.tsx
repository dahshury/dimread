import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { AppSettings } from "@/bindings";
import { StartupSection } from "./StartupSection";

const GENERAL: AppSettings["general"] = {
	anonymousReports: false,
	autostart: false,
	minimizeToTray: true,
};

function renderSection(
	onPatch: (patch: Partial<AppSettings["general"]>) => void,
) {
	return render(
		<IntlProvider>
			<StartupSection general={GENERAL} onPatch={onPatch} />
		</IntlProvider>,
	);
}

describe("StartupSection", () => {
	test("updates start-on-login through the settings patcher", () => {
		const onPatch = mock(() => undefined);
		renderSection(onPatch);

		fireEvent.click(screen.getByRole("switch", { name: "Start on login" }));

		expect(onPatch).toHaveBeenCalledWith({ autostart: true });
	});

	test("keeps anonymous reporting opt-in", () => {
		const onPatch = mock(() => undefined);
		renderSection(onPatch);

		fireEvent.click(
			screen.getByRole("switch", { name: "Send anonymous reports" }),
		);

		expect(onPatch).toHaveBeenCalledWith({ anonymousReports: true });
	});
});
