/**
 * Browser-only backend for auditing the real settings renderer in Chrome.
 *
 * This module is the page entry, not an init script. It installs a stateful
 * Tauri bridge first and only then dynamically imports the production settings
 * entry. Nothing in here starts Tauri or talks to the operating system.
 */
import type {
	AppSettings,
	DiagnosticActionResult,
	DisplayEdit,
	DisplayOutput,
	HotkeyInfo,
	LocationStatus,
	MonitorInfo,
	OpenWindow,
	OperationalIssue,
	PartialSettings,
	SettingsSnapshot,
	SettingsTransferResult,
	TimeZoneOption,
	UpdateCheck,
} from "../../src/bindings";
import { appSettingsSchema } from "../../src/shared/config/settings-schema";
import tauriConfig from "../../src-tauri/tauri.conf.json";

const STORAGE_KEY = "dimread:settings-audit:v1";
const APP_STORE_KEY = "dimread-settings";
const STATE_VERSION = 1;
const MAX_CALLS = 200;
const MAX_EVENTS = 100;
const MAX_DISPLAY_LOG = 100;

type JsonObject = Record<string, unknown>;
type CallStatus = "pending" | "resolved" | "rejected";

interface AuditCall {
	args: JsonObject;
	command: string;
	error?: string;
	id: number;
	response?: unknown;
	status: CallStatus;
	timestamp: number;
}

interface AuditEvent {
	delivered: number;
	event: string;
	payload: unknown;
	timestamp: number;
}

interface FailureRule {
	message: string;
	remaining: number | null;
	transport: boolean;
}

interface DisplayPreview {
	brightness: number | null;
	endpointPhase: "day" | "night" | null;
	kelvin: number | null;
	monitorId: string | null;
}

interface DisplayIntentRecord {
	edit: DisplayEdit;
	snapshot: SettingsSnapshot;
	timestamp: number;
}

interface DisplayPreviewRecord extends DisplayPreview {
	kind: "end" | "preview";
	timestamp: number;
}

interface PersistedAuditState {
	app: {
		locale: string;
		name: string;
		platform: string;
		tauriVersion: string;
		version: string;
	};
	autostart: boolean;
	calls: AuditCall[];
	clipboard: string;
	diagnostics: {
		issues: OperationalIssue[];
		logStreaming: boolean;
	};
	display: {
		current: DisplayOutput;
		intents: DisplayIntentRecord[];
		preview: DisplayPreview | null;
		previewLog: DisplayPreviewRecord[];
	};
	downloads: unknown[];
	events: AuditEvent[];
	failures: Record<string, FailureRule>;
	focus: { blur: boolean; read: boolean };
	hotkeys: HotkeyInfo[];
	location: LocationStatus;
	monitors: MonitorInfo[];
	nextCallId: number;
	openWindows: OpenWindow[];
	queuedImport: AppSettings | null;
	settings: AppSettings;
	settingsRevision: number;
	timezones: TimeZoneOption[];
	update: UpdateCheck;
	version: number;
	visible: boolean;
}

interface FailureOptions {
	times?: number | null;
	transport?: boolean;
}

interface DimReadTestApi {
	readonly ready: Promise<void>;
	addDiagnosticIssue(issue: OperationalIssue): void;
	calls(command?: string): AuditCall[];
	clearCalls(): void;
	clearFailures(command?: string): void;
	emit(event: string, payload: unknown): number;
	failNext(command: string, message?: string): void;
	patchSettings(patch: PartialSettings): SettingsSnapshot;
	queueImport(settings: AppSettings | null): void;
	reload(): void;
	reset(): void;
	setFailure(command: string, message: string, options?: FailureOptions): void;
	setFocus(focus: Partial<{ blur: boolean; read: boolean }>): void;
	setLocation(location: LocationStatus): void;
	setMonitors(monitors: MonitorInfo[]): void;
	setOpenWindows(windows: OpenWindow[]): void;
	setSettings(settings: AppSettings): SettingsSnapshot;
	setTimezones(timezones: TimeZoneOption[]): void;
	setUpdate(update: UpdateCheck): void;
	snapshot(): Readonly<PersistedAuditState> & {
		bootstrapError: string | null;
		listenerCounts: Record<string, number>;
		ready: boolean;
	};
}

declare global {
	interface Window {
		__DIMREAD_TEST__: DimReadTestApi;
		__TAURI_INTERNALS__?: {
			callbacks: Map<number, (payload: unknown) => void>;
			convertFileSrc(path: string): string;
			invoke(command: string, args?: unknown): Promise<unknown>;
			metadata: {
				currentWebview: { label: string; windowLabel: string };
				currentWindow: { label: string };
			};
			transformCallback(
				callback?: (payload: unknown) => void,
				once?: boolean,
			): number;
		};
	}
}

interface EventRegistration {
	callbackId: number;
	eventId: number;
}

interface RuntimeState {
	bootstrapError: string | null;
	listeners: Map<string, Map<number, EventRegistration>>;
	nextCallbackId: number;
	nextEventId: number;
	ready: boolean;
}

type Preset = {
	brightnessDay: number;
	brightnessNight: number;
	kelvinDay: number;
	kelvinNight: number;
};

function clone<T>(value: T): T {
	return structuredClone(value);
}

function serializable<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (_key, item: unknown) =>
			typeof item === "bigint" ? item.toString() : item,
		),
	) as T;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseSettings(value: unknown): AppSettings {
	return appSettingsSchema.parse(value) as AppSettings;
}

function displayOutput(settings: AppSettings, phase = "day"): DisplayOutput {
	const display = settings.display;
	const modes = display.modes as Record<string, Preset>;
	const preset = modes[display.mode] ?? modes["health"] ?? modes["custom"];
	if (!preset) {
		throw new Error("settings audit: display settings have no usable preset");
	}
	const night = phase === "night";
	return {
		brightness: night ? preset.brightnessNight : preset.brightnessDay,
		// A settled phase, so the ramp sits on the matching endpoint.
		factor: night ? 0 : 1,
		grayscaleApplied: display.mode === "reading",
		kelvin: night ? preset.kelvinNight : preset.kelvinDay,
		mode: display.mode,
		phase,
	};
}

function configuredHotkeys(settings: AppSettings): HotkeyInfo[] {
	return Object.entries(settings.hotkeys)
		.filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && entry[1].trim().length > 0,
		)
		.map(([id, accelerator]) => ({
			accelerator: accelerator.trim(),
			active: true,
			error: null,
			id,
		}));
}

function initialSettings(): AppSettings {
	const settings = parseSettings({});
	settings.display.mode = "reading";
	settings.hotkeys.toggleMain = "Ctrl+Shift+D";
	settings.hotkeys.toggleFilter = "Ctrl+Alt+F";
	settings.hotkeys.brightnessUp = "Ctrl+Alt+Up";
	settings.hotkeys.brightnessDown = "Ctrl+Alt+Down";
	settings.hotkeys.tempUp = "Ctrl+Alt+Right";
	settings.hotkeys.tempDown = "Ctrl+Alt+Left";
	settings.hotkeys.focusRead = "F8";
	settings.hotkeys.focusBlur = "Shift+F8";
	settings.rules.enabled = true;
	settings.rules.items = [
		{
			id: "audit-photoshop",
			matchKind: "process",
			mode: "editing",
			pattern: "photoshop.exe",
		},
		{
			id: "audit-kindle",
			matchKind: "title",
			mode: "reading",
			pattern: "Kindle",
		},
	];
	return settings;
}

function createInitialState(): PersistedAuditState {
	const settings = initialSettings();
	return {
		app: {
			locale: "en-US",
			name: "DimRead",
			platform: "windows",
			tauriVersion: "2.11.2",
			version: tauriConfig.version,
		},
		autostart: settings.general.autostart,
		calls: [],
		clipboard: "",
		diagnostics: {
			issues: [
				{
					area: "display",
					detail:
						"The audit fixture records this sample only; no hardware call ran.",
					id: 1,
					operation: "startup probe",
					remediation: "Inspect the stateful harness call log.",
					severity: "warning",
					summary: "Sample audit issue",
					timestampMs: Date.now(),
				},
			],
			logStreaming: false,
		},
		display: {
			current: displayOutput(settings),
			intents: [],
			preview: null,
			previewLog: [],
		},
		downloads: [],
		events: [],
		failures: {},
		focus: { blur: false, read: false },
		hotkeys: configuredHotkeys(settings),
		location: {
			detectedTimezone: "Africa/Cairo",
			resolved: {
				latitude: 30.0444,
				longitude: 31.2357,
				source: "auto",
				timezone: "Africa/Cairo",
			},
			sunriseMinutes: 5 * 60 + 14,
			sunsetMinutes: 18 * 60 + 47,
		},
		monitors: [
			{
				friendlyName: "Dell U2723QE",
				id: "\\\\.\\DISPLAY1",
				index: 0,
				isPrimary: true,
			},
			{
				friendlyName: "LG 27GP850",
				id: "\\\\.\\DISPLAY2",
				index: 1,
				isPrimary: false,
			},
		],
		nextCallId: 1,
		openWindows: [
			{
				className: "Photoshop",
				id: "132518",
				process: "photoshop.exe",
				title: "Adobe Photoshop 2026",
			},
			{
				className: "Chrome_WidgetWin_1",
				id: "265422",
				process: "chrome.exe",
				title: "DimRead settings audit",
			},
		],
		queuedImport: null,
		settings,
		settingsRevision: 1,
		timezones: [
			{
				country: "EG",
				id: "Africa/Cairo",
				latitude: 30.0444,
				longitude: 31.2357,
			},
			{
				country: "GB",
				id: "Europe/London",
				latitude: 51.5,
				longitude: -0.1167,
			},
			{
				country: "US",
				id: "America/New_York",
				latitude: 40.7142,
				longitude: -74.0064,
			},
			{
				country: "JP",
				id: "Asia/Tokyo",
				latitude: 35.6544,
				longitude: 139.7447,
			},
		],
		update: {
			currentVersion: tauriConfig.version,
			downloadName: null,
			downloadUrl: null,
			latestVersion: tauriConfig.version,
			publishedAt: "2026-07-31T00:00:00Z",
			releaseUrl: "https://github.com/dahshury/dimread/releases",
			status: "upToDate",
		},
		version: STATE_VERSION,
		visible: true,
	};
}

function restoreState(): PersistedAuditState {
	const fallback = createInitialState();
	const raw = localStorage.getItem(STORAGE_KEY);
	if (!raw) {
		return fallback;
	}
	try {
		const saved = JSON.parse(raw) as Partial<PersistedAuditState>;
		if (saved.version !== STATE_VERSION) {
			return fallback;
		}
		const settings = parseSettings(saved.settings);
		return {
			...fallback,
			...saved,
			app: { ...fallback.app, ...saved.app },
			diagnostics: { ...fallback.diagnostics, ...saved.diagnostics },
			display: { ...fallback.display, ...saved.display },
			failures: { ...saved.failures },
			settings,
		};
	} catch (error) {
		console.warn("[settings-audit] discarded invalid persisted state", error);
		localStorage.removeItem(STORAGE_KEY);
		return fallback;
	}
}

const launchParams = new URLSearchParams(window.location.search);
if (launchParams.get("reset") === "1") {
	localStorage.removeItem(STORAGE_KEY);
	localStorage.removeItem(APP_STORE_KEY);
}
let state = restoreState();
const launchFailure = launchParams.get("fail");
if (launchFailure && /^[-.:|a-zA-Z0-9_]+$/.test(launchFailure)) {
	const requestedTimes = Number(launchParams.get("times") ?? "1");
	state.failures[launchFailure] = {
		message: launchParams.get("message") ?? "forced launch failure",
		remaining:
			Number.isInteger(requestedTimes) && requestedTimes > 0
				? requestedTimes
				: 1,
		transport: launchParams.get("transport") === "1",
	};
}
if (launchParams.get("import") === "alternate") {
	state.queuedImport = parseSettings({
		...state.settings,
		appearance: {
			...state.settings.appearance,
			reducedMotion: true,
		},
		general: {
			...state.settings.general,
			anonymousReports: true,
			minimizeToTray: false,
		},
	});
}
if (launchParams.get("update") === "available") {
	state.update = {
		currentVersion: tauriConfig.version,
		downloadName: "DimRead-audit-x64-setup.exe",
		downloadUrl: "https://example.invalid/DimRead-audit-x64-setup.exe",
		latestVersion: "9.9.9",
		publishedAt: "2026-07-31T00:00:00Z",
		releaseUrl: "https://example.invalid/releases/9.9.9",
		status: "updateAvailable",
	};
} else if (launchParams.get("update") === "ahead") {
	state.update = {
		...state.update,
		latestVersion: "0.0.1",
		status: "ahead",
	};
}
if (window.location.search) {
	window.history.replaceState(null, "", window.location.pathname);
}
const runtime: RuntimeState = {
	bootstrapError: null,
	listeners: new Map(),
	nextCallbackId: 1,
	nextEventId: 1,
	ready: false,
};
const callbacks = new Map<number, (payload: unknown) => void>();

function persist(): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	const oracle = document.getElementById("dimread-audit-state");
	if (oracle) {
		oracle.textContent = JSON.stringify(state);
	}
}

function trimLogs(): void {
	state.calls = state.calls.slice(-MAX_CALLS);
	state.events = state.events.slice(-MAX_EVENTS);
	state.display.intents = state.display.intents.slice(-MAX_DISPLAY_LOG);
	state.display.previewLog = state.display.previewLog.slice(-MAX_DISPLAY_LOG);
}

function settingsSnapshot(): SettingsSnapshot {
	return {
		revision: state.settingsRevision,
		settings: clone(state.settings),
	};
}

function currentLocationStatus(): LocationStatus {
	const configured = state.settings.dayNight;
	if (!configured.useLocation) {
		return clone(state.location);
	}
	if (configured.locationSource === "manual") {
		return {
			detectedTimezone: state.location.detectedTimezone,
			resolved: {
				latitude: configured.latitude,
				longitude: configured.longitude,
				source: "manual",
				timezone: null,
			},
			sunriseMinutes: state.location.sunriseMinutes,
			sunsetMinutes: state.location.sunsetMinutes,
		};
	}
	const requested =
		configured.locationSource === "timezone"
			? configured.timezone
			: state.location.detectedTimezone;
	const zone = state.timezones.find((option) => option.id === requested);
	if (!zone) {
		return {
			...clone(state.location),
			resolved: {
				latitude: configured.latitude,
				longitude: configured.longitude,
				source: "unresolved",
				timezone: requested,
			},
		};
	}
	return {
		detectedTimezone: state.location.detectedTimezone,
		resolved: {
			latitude: zone.latitude,
			longitude: zone.longitude,
			source: configured.locationSource === "timezone" ? "timezone" : "auto",
			timezone: zone.id,
		},
		sunriseMinutes: state.location.sunriseMinutes,
		sunsetMinutes: state.location.sunsetMinutes,
	};
}

function validateName(name: string, kind: string): void {
	if (
		name.length === 0 ||
		name.length > 160 ||
		!/^[-.:|a-zA-Z0-9_]+$/.test(name) ||
		name === "__proto__" ||
		name === "constructor"
	) {
		throw new TypeError(`settings audit: invalid ${kind} name`);
	}
}

function emitEvent(event: string, payload: unknown): number {
	validateName(event, "event");
	const registrations = runtime.listeners.get(event);
	let delivered = 0;
	if (registrations) {
		for (const registration of registrations.values()) {
			const callback = callbacks.get(registration.callbackId);
			if (!callback) {
				continue;
			}
			callback({ event, id: registration.eventId, payload: clone(payload) });
			delivered += 1;
		}
	}
	state.events.push({
		delivered,
		event,
		payload: serializable(payload),
		timestamp: Date.now(),
	});
	trimLogs();
	persist();
	return delivered;
}

function broadcastSettings(): void {
	const snapshot = settingsSnapshot();
	queueMicrotask(() => {
		emitEvent("settings:changed", snapshot);
	});
}

function refreshDisplay(emit = true): void {
	state.display.current = displayOutput(
		state.settings,
		state.display.current.phase,
	);
	if (emit) {
		queueMicrotask(() => {
			emitEvent("display:state", state.display.current);
		});
	}
}

function adoptSettings(next: unknown): SettingsSnapshot {
	state.settings = parseSettings(next);
	state.settingsRevision += 1;
	state.autostart = state.settings.general.autostart;
	state.hotkeys = configuredHotkeys(state.settings);
	state.display.preview = null;
	refreshDisplay();
	broadcastSettings();
	persist();
	return settingsSnapshot();
}

function applySettingsPatch(patch: PartialSettings): SettingsSnapshot {
	const next = clone(state.settings) as unknown as JsonObject;
	for (const [section, value] of Object.entries(patch)) {
		if (value !== null && value !== undefined) {
			next[section] = clone(value);
		}
	}
	return adoptSettings(next);
}

function setDisplayValue(edit: DisplayEdit): SettingsSnapshot {
	const display = clone(state.settings.display);
	const modes = display.modes as Record<string, Preset>;
	if (display.mode === "pause") {
		display.mode = "custom";
	}
	const active = modes[display.mode] ?? modes["custom"] ?? modes["health"];
	if (!active) {
		throw new Error("settings audit: display intent has no target preset");
	}
	let target = active;
	if (edit.monitorId !== null) {
		target = display.monitorOverrides[edit.monitorId] ?? clone(active);
		display.monitorOverrides[edit.monitorId] = target;
	}
	const suffix = edit.phase === "night" ? "Night" : "Day";
	const key = `${edit.axis}${suffix}` as keyof Preset;
	target[key] = edit.value;
	state.settings = parseSettings({ ...state.settings, display });
	state.settingsRevision += 1;
	state.display.preview = null;
	refreshDisplay();
	const snapshot = settingsSnapshot();
	state.display.intents.push({
		edit: clone(edit),
		snapshot,
		timestamp: Date.now(),
	});
	broadcastSettings();
	trimLogs();
	persist();
	return snapshot;
}

function registerEvent(args: JsonObject): number {
	const event = String(args["event"] ?? "");
	const callbackId = Number(args["handler"]);
	validateName(event, "event");
	if (!Number.isInteger(callbackId) || !callbacks.has(callbackId)) {
		throw new Error(
			"settings audit: event listener has no registered callback",
		);
	}
	const eventId = runtime.nextEventId++;
	const registrations = runtime.listeners.get(event) ?? new Map();
	registrations.set(eventId, { callbackId, eventId });
	runtime.listeners.set(event, registrations);
	return eventId;
}

function unregisterEvent(args: JsonObject): null {
	const event = String(args["event"] ?? "");
	const eventId = Number(args["eventId"]);
	const registrations = runtime.listeners.get(event);
	const registration = registrations?.get(eventId);
	if (registration) {
		callbacks.delete(registration.callbackId);
		registrations?.delete(eventId);
	}
	if (registrations?.size === 0) {
		runtime.listeners.delete(event);
	}
	return null;
}

const successfulAction = (path: string): DiagnosticActionResult => ({
	ok: true,
	path,
});

const handlers: Record<
	string,
	(args: JsonObject) => Promise<unknown> | unknown
> = {
	app_quit: () => {
		state.visible = false;
		persist();
		return null;
	},
	close_self_window: () => {
		state.visible = false;
		persist();
		return null;
	},
	close_window: () => null,
	daynight_list_timezones: () => clone(state.timezones),
	daynight_location_status: currentLocationStatus,
	diagnostics_clear_issues: () => {
		const removed = state.diagnostics.issues.length;
		state.diagnostics.issues = [];
		persist();
		return removed;
	},
	diagnostics_open_logs_folder: () =>
		successfulAction("C:\\DimRead Audit\\logs"),
	diagnostics_recent_issues: (args) => {
		const requested = args["limit"];
		const limit = typeof requested === "number" ? requested : 50;
		return clone(state.diagnostics.issues.slice(-Math.max(0, limit)));
	},
	diagnostics_save_bundle: () =>
		successfulAction("C:\\DimRead Audit\\dimread-diagnostics.zip"),
	diagnostics_set_log_streaming: (args) => {
		state.diagnostics.logStreaming = Boolean(args["enabled"]);
		if (state.diagnostics.logStreaming) {
			emitEvent("diagnostics:log-line", {
				level: "info",
				message: "Audit log streaming is active.",
				target: "dimread::audit",
				timestampMs: Date.now(),
			});
		}
		persist();
		return state.diagnostics.logStreaming;
	},
	display_current: () => clone(state.display.current),
	display_list_monitors: () => clone(state.monitors),
	display_preview: (args) => {
		const preview: DisplayPreview = {
			brightness:
				typeof args["brightness"] === "number" ? args["brightness"] : null,
			endpointPhase:
				args["endpointPhase"] === "day" || args["endpointPhase"] === "night"
					? args["endpointPhase"]
					: null,
			kelvin: typeof args["kelvin"] === "number" ? args["kelvin"] : null,
			monitorId:
				typeof args["monitorId"] === "string" ? args["monitorId"] : null,
		};
		state.display.preview = preview;
		state.display.previewLog.push({
			...preview,
			kind: "preview",
			timestamp: Date.now(),
		});
		state.display.current = {
			...state.display.current,
			...(preview.brightness === null
				? {}
				: { brightness: preview.brightness }),
			...(preview.kelvin === null ? {} : { kelvin: preview.kelvin }),
		};
		emitEvent("display:state", state.display.current);
		trimLogs();
		persist();
		return null;
	},
	display_preview_end: () => {
		state.display.preview = null;
		state.display.previewLog.push({
			brightness: null,
			endpointPhase: null,
			kelvin: null,
			kind: "end",
			monitorId: null,
			timestamp: Date.now(),
		});
		refreshDisplay();
		trimLogs();
		persist();
		return null;
	},
	display_set_value: (args) => setDisplayValue(args["edit"] as DisplayEdit),
	download_list: () => clone(state.downloads),
	focus_active_state: () => clone(state.focus),
	focus_blur_toggle: () => {
		state.focus.blur = !state.focus.blur;
		if (state.focus.blur) {
			state.focus.read = false;
		}
		emitEvent("focus:state", state.focus);
		persist();
		return state.focus.blur;
	},
	focus_read_toggle: () => {
		state.focus.read = !state.focus.read;
		if (state.focus.read) {
			state.focus.blur = false;
		}
		emitEvent("focus:state", state.focus);
		persist();
		return state.focus.read;
	},
	hide_app_window: () => {
		state.visible = false;
		persist();
		return null;
	},
	hotkey_list: () => clone(state.hotkeys),
	hotkey_register: (args) => {
		const id = String(args["id"] ?? "");
		const accelerator = String(args["accelerator"] ?? "").trim();
		validateName(id, "hotkey");
		if (!accelerator) {
			throw "hotkey accelerator cannot be empty";
		}
		const duplicate = state.hotkeys.find(
			(item) => item.id !== id && item.accelerator === accelerator,
		);
		if (duplicate) {
			throw `hotkey already registered by ${duplicate.id}`;
		}
		state.hotkeys = state.hotkeys.filter((item) => item.id !== id);
		state.hotkeys.push({ accelerator, active: true, error: null, id });
		persist();
		return null;
	},
	hotkey_unregister: (args) => {
		const id = String(args["id"] ?? "");
		state.hotkeys = state.hotkeys.filter((item) => item.id !== id);
		persist();
		return null;
	},
	magictoolbar_hide_complete: () => null,
	magictoolbar_renderer_ready: () => null,
	magicx_clear_target: () => null,
	magicx_toggle_effect: () => null,
	open_downloads_dir: () => null,
	open_window: () => null,
	overlay_dismiss: () => null,
	overlay_hide_complete: () => null,
	overlay_snapshot: () => ({ notification: null, sequence: 0 }),
	"plugin:app|name": () => state.app.name,
	"plugin:app|tauri_version": () => state.app.tauriVersion,
	"plugin:app|version": () => state.app.version,
	"plugin:autostart|disable": () => {
		state.autostart = false;
		persist();
		return null;
	},
	"plugin:autostart|enable": () => {
		state.autostart = true;
		persist();
		return null;
	},
	"plugin:autostart|is_enabled": () => state.autostart,
	"plugin:clipboard-manager|read_text": () => state.clipboard,
	"plugin:clipboard-manager|write_text": (args) => {
		state.clipboard = String(args["text"] ?? "");
		persist();
		return null;
	},
	"plugin:event|emit": (args) => {
		emitEvent(String(args["event"] ?? ""), args["payload"]);
		return null;
	},
	"plugin:event|emit_to": (args) => {
		emitEvent(String(args["event"] ?? ""), args["payload"]);
		return null;
	},
	"plugin:event|listen": registerEvent,
	"plugin:event|unlisten": unregisterEvent,
	"plugin:opener|open_path": () => null,
	"plugin:opener|open_url": () => null,
	"plugin:os|locale": () => state.app.locale,
	"plugin:os|platform": () => state.app.platform,
	"plugin:window|is_visible": () => state.visible,
	rules_list_windows: () => clone(state.openWindows),
	settings_export_backup: () =>
		({
			ok: true,
			path: "C:\\DimRead Audit\\dimread-settings.json",
			snapshot: settingsSnapshot(),
		}) satisfies SettingsTransferResult,
	settings_import_backup: () => {
		if (state.queuedImport === null) {
			return {
				cancelled: true,
				ok: false,
			} satisfies SettingsTransferResult;
		}
		const imported = state.queuedImport;
		state.queuedImport = null;
		return {
			ok: true,
			path: "C:\\DimRead Audit\\imported-settings.json",
			snapshot: adoptSettings(imported),
		} satisfies SettingsTransferResult;
	},
	settings_load_snapshot: settingsSnapshot,
	settings_reset_defaults: () => adoptSettings(parseSettings({})),
	settings_save: (args) => {
		const revision = Number(args["revision"]);
		if (revision !== state.settingsRevision) {
			throw `settings revision conflict: expected ${state.settingsRevision}, got ${revision}`;
		}
		return applySettingsPatch(args["patch"] as PartialSettings);
	},
	show_app_window: () => {
		state.visible = true;
		persist();
		return null;
	},
	tray_menu_hide: () => null,
	tray_menu_resize: () => null,
	update_check: () => clone(state.update),
};

function consumeFailure(command: string): FailureRule | null {
	if (!Object.hasOwn(state.failures, command)) {
		return null;
	}
	const rule = state.failures[command];
	if (!rule) {
		return null;
	}
	if (rule.remaining !== null) {
		rule.remaining -= 1;
		if (rule.remaining <= 0) {
			delete state.failures[command];
		}
	}
	persist();
	return rule;
}

async function invoke(command: string, rawArgs?: unknown): Promise<unknown> {
	validateName(command, "command");
	const args =
		rawArgs !== null && typeof rawArgs === "object"
			? (serializable(rawArgs) as JsonObject)
			: {};
	const call: AuditCall = {
		args,
		command,
		id: state.nextCallId++,
		status: "pending",
		timestamp: Date.now(),
	};
	state.calls.push(call);
	trimLogs();
	persist();
	try {
		const failure = consumeFailure(command);
		if (failure) {
			if (failure.transport) {
				throw new Error(failure.message);
			}
			throw failure.message;
		}
		const handler = Object.hasOwn(handlers, command) ? handlers[command] : null;
		if (!handler) {
			throw new Error(`settings audit: no IPC handler for ${command}`);
		}
		const response = await handler(args);
		call.response = serializable(response);
		call.status = "resolved";
		persist();
		return clone(response);
	} catch (error) {
		call.error = errorMessage(error);
		call.status = "rejected";
		persist();
		throw error;
	}
}

function listenerCounts(): Record<string, number> {
	return Object.fromEntries(
		[...runtime.listeners.entries()].map(([event, registrations]) => [
			event,
			registrations.size,
		]),
	);
}

let resolveReady: (() => void) | undefined;
const ready = new Promise<void>((resolve) => {
	resolveReady = resolve;
});

const api: DimReadTestApi = {
	ready,
	addDiagnosticIssue(issue) {
		state.diagnostics.issues.push(clone(issue));
		persist();
	},
	calls(command) {
		const calls = command
			? state.calls.filter((call) => call.command === command)
			: state.calls;
		return clone(calls);
	},
	clearCalls() {
		state.calls = [];
		persist();
	},
	clearFailures(command) {
		if (command) {
			validateName(command, "command");
			delete state.failures[command];
		} else {
			state.failures = {};
		}
		persist();
	},
	emit: emitEvent,
	failNext(command, message = "forced audit failure") {
		this.setFailure(command, message, { times: 1 });
	},
	patchSettings: applySettingsPatch,
	queueImport(settings) {
		state.queuedImport = settings === null ? null : parseSettings(settings);
		persist();
	},
	reload() {
		window.location.reload();
	},
	reset() {
		state = createInitialState();
		localStorage.removeItem(APP_STORE_KEY);
		persist();
	},
	setFailure(command, message, options = {}) {
		validateName(command, "command");
		const times = options.times ?? null;
		if (times !== null && (!Number.isInteger(times) || times < 1)) {
			throw new RangeError("settings audit: failure times must be positive");
		}
		state.failures[command] = {
			message,
			remaining: times,
			transport: options.transport ?? false,
		};
		persist();
	},
	setFocus(focus) {
		state.focus = { ...state.focus, ...focus };
		emitEvent("focus:state", state.focus);
		persist();
	},
	setLocation(location) {
		state.location = clone(location);
		persist();
	},
	setMonitors(monitors) {
		state.monitors = clone(monitors);
		emitEvent("display:topology", state.monitors);
		persist();
	},
	setOpenWindows(windows) {
		state.openWindows = clone(windows);
		persist();
	},
	setSettings(settings) {
		return adoptSettings(settings);
	},
	setTimezones(timezones) {
		state.timezones = clone(timezones);
		persist();
	},
	setUpdate(update) {
		state.update = clone(update);
		persist();
	},
	snapshot() {
		return Object.freeze({
			...clone(state),
			bootstrapError: runtime.bootstrapError,
			listenerCounts: listenerCounts(),
			ready: runtime.ready,
		});
	},
};

Object.defineProperty(window, "__DIMREAD_TEST__", {
	configurable: false,
	enumerable: false,
	value: Object.freeze(api),
	writable: false,
});

Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	enumerable: false,
	value: {
		callbacks,
		convertFileSrc: (path: string) => path,
		invoke,
		metadata: {
			currentWebview: { label: "settings", windowLabel: "settings" },
			currentWindow: { label: "settings" },
		},
		transformCallback(
			callback?: (payload: unknown) => void,
			once = false,
		): number {
			const id = runtime.nextCallbackId++;
			if (callback) {
				const registered = once
					? (payload: unknown) => {
							callbacks.delete(id);
							callback(payload);
						}
					: callback;
				callbacks.set(id, registered);
				Object.defineProperty(window, `_${id}`, {
					configurable: true,
					value: registered,
				});
			}
			return id;
		},
	},
	writable: false,
});

// Chrome exposes the Web Clipboard API on localhost, so the production helper
// correctly prefers it over the Tauri plugin. Route that browser-native path
// into the same observable audit state so Copy buttons can be asserted without
// reading or mutating the developer machine's real clipboard.
Object.defineProperty(navigator, "clipboard", {
	configurable: true,
	value: {
		readText: async () => state.clipboard,
		writeText: async (value: string) => {
			state.clipboard = value;
			persist();
		},
	},
});

persist();

try {
	// Vite resolves this browser-only TSX entry. The Node tooling config also
	// checks `tools/**` but intentionally has no JSX transform.
	// @ts-expect-error -- this audit bootstrap is executed by Vite, not Node.
	await import("../../src/entries/settings.tsx");
	runtime.ready = true;
	document.documentElement.dataset["dimreadAuditReady"] = "true";
} catch (error) {
	runtime.bootstrapError = errorMessage(error);
	document.documentElement.dataset["dimreadAuditReady"] = "error";
	console.error("[settings-audit] renderer bootstrap failed", error);
} finally {
	resolveReady?.();
}

export {};
