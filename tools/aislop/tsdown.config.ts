import fs from "node:fs";
import { defineConfig } from "tsdown";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
	version: string;
};

// tsdown string patterns only match exact specifiers, so subpath imports
// (e.g. "@modelcontextprotocol/sdk/server/mcp.js", "zod/v4") need RegExp.
const BUNDLE_DEPS = [
	"@clack/prompts",
	"@modelcontextprotocol/sdk",
	"adm-zip",
	"commander",
	"expo-doctor",
	"ink",
	"ink-select-input",
	"micromatch",
	"picocolors",
	"react",
	"smol-toml",
	"tar",
	"typescript",
	"wcwidth",
	"yaml",
	"zod",
];
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bundlePatterns = BUNDLE_DEPS.map((d) => new RegExp(`^${escapeRegExp(d)}($|/)`));

export default defineConfig([
	{
		entry: {
			cli: "./src/cli.ts",
		},
		deps: {
			neverBundle: ["oxlint", "knip", "knip/session", "@biomejs/biome", "typescript"],
		},
		dts: true,
		target: "node18",
		platform: "node",
		env: {
			VERSION: process.env.VERSION ?? packageJson.version,
		},
		fixedExtension: false,
		banner: "#!/usr/bin/env node",
	},
	{
		entry: {
			index: "./src/index.ts",
			"adapters/astro": "./src/framework-adapters/astro.ts",
			"adapters/expo": "./src/framework-adapters/expo.ts",
			"adapters/nuxt": "./src/framework-adapters/nuxt.ts",
			"adapters/sveltekit": "./src/framework-adapters/sveltekit.ts",
			"adapters/vite": "./src/framework-adapters/vite.ts",
		},
		deps: {
			neverBundle: ["oxlint", "knip", "knip/session", "@biomejs/biome", "typescript"],
		},
		dts: true,
		target: "node18",
		platform: "node",
		env: {
			VERSION: process.env.VERSION ?? packageJson.version,
		},
		fixedExtension: false,
	},
	{
		entry: {
			mcp: "./src/mcp.ts",
		},
		deps: {
			// The MCP bundle must run from the installer runtime dir without
			// node_modules, so every JS dependency reachable from src/mcp.ts
			// is bundled in. Only binary/subprocess tools stay external
			// (never imported in src, resolved via PATH at runtime).
			neverBundle: ["oxlint", "knip", "knip/session", "@biomejs/biome"],
			alwaysBundle: bundlePatterns,
		},
		dts: false,
		target: "node18",
		platform: "node",
		// Bundled typescript compiler code uses CJS __filename; define ESM shims.
		shims: true,
		env: {
			VERSION: process.env.VERSION ?? packageJson.version,
		},
		fixedExtension: false,
		banner: "#!/usr/bin/env node",
	},
]);
