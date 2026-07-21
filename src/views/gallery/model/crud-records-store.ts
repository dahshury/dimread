import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateId } from "@/shared/lib/generate-id";

export interface TaskRecord {
	id: string;
	owner: string;
	status: string;
	task: string;
}

const OWNERS = ["Ada", "Grace", "Linus", "Margaret", "Alan"];
const STATUSES = ["todo", "doing", "done", "blocked"];

/** Deterministic starter rows so the demo grid never opens empty. */
export function seedTasks(): TaskRecord[] {
	return Array.from({ length: 20 }, (_, index) => ({
		id: `task-${index + 1}`,
		task: `Demo task ${index + 1}`,
		owner: OWNERS[index % OWNERS.length] ?? "Ada",
		status: STATUSES[index % STATUSES.length] ?? "todo",
	}));
}

/** A blank row appended by the grid's add-row affordance. */
export function createTask(): TaskRecord {
	return { id: generateId(), task: "", owner: "", status: "" };
}

export const isBlankTask = (row: TaskRecord): boolean =>
	row.task.trim() === "" && row.owner.trim() === "" && row.status.trim() === "";

interface CrudRecordsState {
	/** Restore the pristine seed (the demo's escape hatch). */
	reset: () => void;
	rows: TaskRecord[];
	/** Whole-array replacement — the EditableRecordsGrid contract. */
	setRows: (rows: TaskRecord[]) => void;
}

/**
 * Backing store for the gallery's CRUD grid demo: the full add/edit/delete/
 * sort/filter surface of `EditableRecordsGrid` persisted to localStorage, so
 * edits survive a window close the way a real records screen would.
 */
export const useCrudRecordsStore = create<CrudRecordsState>()(
	persist(
		(set) => ({
			rows: seedTasks(),
			setRows: (rows) => set({ rows }),
			reset: () => set({ rows: seedTasks() }),
		}),
		{ name: "starter-gallery-crud", version: 1 },
	),
);
