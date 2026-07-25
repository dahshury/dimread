import { describe, expect, test } from "bun:test";
import {
	subscribeNativeEvent,
	subscribeNativeEventPair,
	type Unsubscribe,
} from "./subscribe-native-event";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, reject, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("subscribeNativeEvent", () => {
	test("runs the handshake after registration and owns cleanup", async () => {
		let handler: ((event: number) => void) | null = null;
		let stopped = 0;
		let handshakes = 0;
		const unsubscribe = subscribeNativeEvent(
			{
				listen: async (next) => {
					handler = next;
					return () => {
						stopped += 1;
					};
				},
			},
			() => undefined,
			() => {
				handshakes += 1;
			},
		);
		await flush();
		expect(handler).not.toBeNull();
		expect(handshakes).toBe(1);
		unsubscribe();
		expect(stopped).toBe(1);
	});

	test("pair disposal before registration resolves stops both streams", async () => {
		const first = deferred<Unsubscribe>();
		const second = deferred<Unsubscribe>();
		let stopped = 0;
		let handshakes = 0;
		const unsubscribe = subscribeNativeEventPair(
			{ listen: () => first.promise },
			() => undefined,
			{ listen: () => second.promise },
			() => undefined,
			() => {
				handshakes += 1;
			},
		);
		unsubscribe();
		first.resolve(() => {
			stopped += 1;
		});
		second.resolve(() => {
			stopped += 1;
		});
		await flush();
		expect(stopped).toBe(2);
		expect(handshakes).toBe(0);
	});

	test("a partial pair-registration failure tears down its sibling", async () => {
		const originalError = console.error;
		console.error = () => undefined;
		let stopped = 0;
		try {
			const unsubscribe = subscribeNativeEventPair(
				{
					listen: async () => () => {
						stopped += 1;
					},
				},
				() => undefined,
				{ listen: async () => Promise.reject(new Error("denied")) },
				() => undefined,
			);
			await flush();
			expect(stopped).toBe(1);
			unsubscribe();
		} finally {
			console.error = originalError;
		}
	});
});
