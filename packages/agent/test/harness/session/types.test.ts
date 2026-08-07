import { describe, expectTypeOf, it } from "vitest";
import type { EntryQuery } from "../../../src/harness/session/index.ts";

describe("EntryQuery", () => {
	it("permits valid custom and non-custom filters", () => {
		expectTypeOf<{ customType: "note" }>().toExtend<EntryQuery>();
		expectTypeOf<{ type: "custom"; customType: "note" }>().toExtend<EntryQuery>();
		expectTypeOf<{ type: "message" }>().toExtend<EntryQuery>();
	});

	it("forbids customType with a non-custom type", () => {
		expectTypeOf<{ type: "message"; customType: "note" }>().not.toExtend<EntryQuery>();
	});
});
