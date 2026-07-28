import { describe, expect, test } from "bun:test";
import type { TimeZoneOption } from "@/bindings";
import {
	buildTimezoneGroups,
	formatMinutesOfDay,
	zoneCity,
} from "./timezone-options";

const zones: TimeZoneOption[] = [
	{ country: "DE", id: "Europe/Berlin", latitude: 52.5, longitude: 13.37 },
	{ country: "FR", id: "Europe/Paris", latitude: 48.87, longitude: 2.33 },
	{
		country: "AR",
		id: "America/Argentina/Buenos_Aires",
		latitude: -34.6,
		longitude: -58.45,
	},
];

const build = () =>
	buildTimezoneGroups({
		formatLabel: (city, country) => `${city}, ${country}`,
		locale: "en",
		zones,
	});

describe("zoneCity", () => {
	test("takes the locality, not the region, and unescapes it", () => {
		expect(zoneCity("Europe/Berlin")).toBe("Berlin");
		expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
		expect(zoneCity("UTC")).toBe("UTC");
	});
});

describe("buildTimezoneGroups", () => {
	test("groups by region and labels rows by city and country", () => {
		const groups = build();
		expect(groups.map((group) => group.value)).toEqual(["Europe", "America"]);
		expect(groups[0]?.options.map((option) => option.label)).toEqual([
			"Berlin, Germany",
			"Paris, France",
		]);
	});

	test("keeps the zone id as the option id so search can match it", () => {
		// The combobox's fuzzy match spans label + id + badge, which is what lets
		// "Berlin", "Germany", "DE" and "Europe/Berlin" all find the same row.
		const [europe] = build();
		expect(europe?.options[0]?.id).toBe("Europe/Berlin");
		expect(europe?.options[0]?.badge).toBe("DE");
	});

	test("a nested zone is grouped by its top-level region", () => {
		const america = build().find((group) => group.value === "America");
		expect(america?.options).toHaveLength(1);
		expect(america?.options[0]?.label).toBe("Buenos Aires, Argentina");
	});
});

describe("formatMinutesOfDay", () => {
	test("renders local minutes-of-day as a zero-padded clock time", () => {
		expect(formatMinutesOfDay(0)).toBe("00:00");
		expect(formatMinutesOfDay(312.5)).toBe("05:13");
		expect(formatMinutesOfDay(1281)).toBe("21:21");
	});

	test("wraps times that fall outside the day", () => {
		// suncalc can land just past midnight at extreme longitudes; 24:07 is
		// 00:07, not a broken clock.
		expect(formatMinutesOfDay(1447)).toBe("00:07");
		expect(formatMinutesOfDay(-30)).toBe("23:30");
	});
});
