import { describe, expect, test } from "bun:test";
import { formatHm, parseHm } from "./hm-time";

describe("parseHm", () => {
	test("parses a well-formed clock string", () => {
		expect(parseHm("07:30")).toEqual({ hours: 7, minutes: 30 });
		expect(parseHm("19:05")).toEqual({ hours: 19, minutes: 5 });
	});

	test("clamps out-of-range parts", () => {
		expect(parseHm("31:90")).toEqual({ hours: 23, minutes: 59 });
		expect(parseHm("-2:-4")).toEqual({ hours: 0, minutes: 0 });
	});

	test("heals malformed / partial input to zero", () => {
		expect(parseHm("")).toEqual({ hours: 0, minutes: 0 });
		expect(parseHm("abc")).toEqual({ hours: 0, minutes: 0 });
		expect(parseHm("08")).toEqual({ hours: 8, minutes: 0 });
	});
});

describe("formatHm", () => {
	test("zero-pads both parts", () => {
		expect(formatHm(7, 5)).toBe("07:05");
		expect(formatHm(19, 30)).toBe("19:30");
	});

	test("clamps and truncates before formatting", () => {
		expect(formatHm(30, 75)).toBe("23:59");
		expect(formatHm(8.9, 4.6)).toBe("08:04");
	});

	test("round-trips through parseHm", () => {
		const parsed = parseHm("06:47");
		expect(formatHm(parsed.hours, parsed.minutes)).toBe("06:47");
	});
});
