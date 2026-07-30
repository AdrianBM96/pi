import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-ai\/schemas$/,
				replacement: fileURLToPath(new URL("../ai/src/schemas.ts", import.meta.url)),
			},
		],
	},
});
