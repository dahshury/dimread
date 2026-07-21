import { beforeEach, describe, expect, test } from "bun:test";
import {
	createTask,
	isBlankTask,
	seedTasks,
	useCrudRecordsStore,
} from "./crud-records-store";

beforeEach(() => {
	useCrudRecordsStore.setState({ rows: seedTasks() });
});

describe("crud-records-store", () => {
	test("seeds 20 deterministic rows", () => {
		const rows = useCrudRecordsStore.getState().rows;
		expect(rows.length).toBe(20);
		expect(rows[0]).toEqual({
			id: "task-1",
			task: "Demo task 1",
			owner: "Ada",
			status: "todo",
		});
		// Deterministic: two seeds are identical.
		expect(seedTasks()).toEqual(seedTasks());
	});

	test("setRows replaces the array (grid contract)", () => {
		const next = [{ id: "x", task: "T", owner: "O", status: "done" }];
		useCrudRecordsStore.getState().setRows(next);
		expect(useCrudRecordsStore.getState().rows).toEqual(next);
	});

	test("reset restores the pristine seed", () => {
		useCrudRecordsStore.getState().setRows([]);
		useCrudRecordsStore.getState().reset();
		expect(useCrudRecordsStore.getState().rows.length).toBe(20);
	});

	test("createTask makes unique blank rows that isBlankTask recognizes", () => {
		const a = createTask();
		const b = createTask();
		expect(a.id).not.toBe(b.id);
		expect(isBlankTask(a)).toBe(true);
		expect(isBlankTask({ ...a, task: "typed" })).toBe(false);
	});
});
