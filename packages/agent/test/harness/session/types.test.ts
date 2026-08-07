import { describe, expectTypeOf, it } from "vitest";
import type { EntryQuery } from "../../../src/harness/session/index.ts";

describe("EntryQuery", () => {
	it("constrains customType to custom entries", () => {
		expectTypeOf<{ limit: 1 }>().toExtend<EntryQuery>();
		expectTypeOf<{ type: "custom" }>().toExtend<EntryQuery>();
		expectTypeOf<{ type: "custom"; customType: "note" }>().toExtend<EntryQuery>();
		expectTypeOf<{ type: "message" }>().toExtend<EntryQuery>();
		expectTypeOf<{ customType: "note" }>().not.toExtend<EntryQuery>();
		expectTypeOf<{ type: "message"; customType: "note" }>().not.toExtend<EntryQuery>();
	});
});
