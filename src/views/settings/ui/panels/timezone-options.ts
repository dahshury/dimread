import type { TimeZoneOption } from "@/bindings";
import type { SelectOption } from "@/shared/ui/select";
import type { SelectOptionGroup } from "@/shared/ui/searchable-select";

/**
 * Turns the backend's 400-odd IANA zones into picker groups.
 *
 * A raw id list ("Europe/Berlin", "America/Argentina/Buenos_Aires") is a poor
 * thing to hunt through, so each row is presented as the city and country a user
 * would actually search for, grouped by region. The zone id stays as the option
 * `id`, which the combobox's fuzzy match also searches — so typing "Berlin",
 * "Germany", "DE" or "Europe/Berlin" all find the same row.
 */

/** Country names come from the platform, not a bundled table. */
function countryNamer(locale: string): (code: string) => string {
	try {
		const names = new Intl.DisplayNames([locale], { type: "region" });
		return (code) => names.of(code) ?? code;
	} catch {
		// Intl.DisplayNames is missing or the locale is unsupported — the ISO
		// code is a worse label but still an unambiguous one.
		return (code) => code;
	}
}

/** `"America/Argentina/Buenos_Aires"` → `"Buenos Aires"`. */
export function zoneCity(id: string): string {
	return (id.split("/").at(-1) ?? id).replaceAll("_", " ");
}

/** `"America/Argentina/Buenos_Aires"` → `"America"`. */
function zoneRegion(id: string): string {
	return (id.split("/")[0] ?? id).replaceAll("_", " ");
}

export interface TimezoneGroupOptions {
	/** BCP-47 tag used to localize country names. */
	locale: string;
	/** `(city, country) => label`, so the panel's i18n owns the format. */
	formatLabel: (city: string, country: string) => string;
	zones: readonly TimeZoneOption[];
}

export function buildTimezoneGroups({
	formatLabel,
	locale,
	zones,
}: TimezoneGroupOptions): SelectOptionGroup[] {
	const countryName = countryNamer(locale);
	const byRegion = new Map<string, SelectOption[]>();
	for (const zone of zones) {
		const region = zoneRegion(zone.id);
		const rows = byRegion.get(region) ?? [];
		rows.push({
			badge: zone.country,
			id: zone.id,
			label: formatLabel(zoneCity(zone.id), countryName(zone.country)),
		});
		byRegion.set(region, rows);
	}
	// The backend sends zones sorted by id, so both the groups and the rows
	// inside them are already in a stable order.
	return [...byRegion].map(([region, options]) => ({
		label: region,
		options,
		value: region,
	}));
}

/** `312.5` → `"05:12"`. Sun times cross the wire as local minutes of day, and
 *  can land just outside `0..1440` at extreme longitudes — a sunset at 24:07 is
 *  00:07, not a broken clock. */
export function formatMinutesOfDay(minutes: number): string {
	const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
	const hours = Math.floor(total / 60);
	return `${String(hours).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
