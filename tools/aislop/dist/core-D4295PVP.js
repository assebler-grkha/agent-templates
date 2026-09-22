import { spawn } from "node:child_process";
import process from "node:process";
//#region src/framework-adapters/core.ts
const DEFAULT_ARGS = {
	ci: ["ci"],
	scan: ["scan"]
};
const resolveAislopRunRequest = (framework, options = {}) => {
	const command = options.command ?? "ci";
	const env = options.env ? {
		...process.env,
		...options.env
	} : { ...process.env };
	return {
		framework,
		bin: options.bin ?? "aislop",
		args: [...DEFAULT_ARGS[command], ...options.args ?? []],
		cwd: options.cwd ?? process.cwd(),
		env
	};
};
const runAislop = async (request) => new Promise((resolve) => {
	spawn(request.bin, request.args, {
		cwd: request.cwd,
		env: request.env,
		stdio: "inherit"
	}).on("close", (exitCode, signal) => {
		resolve({
			command: request.bin,
			args: request.args,
			exitCode,
			signal,
			skipped: false
		});
	});
});
const maybeRunAislop = async (framework, options = {}) => {
	const request = resolveAislopRunRequest(framework, options);
	if (options.enabled !== true) return {
		command: request.bin,
		args: request.args,
		exitCode: 0,
		signal: null,
		skipped: true
	};
	const result = await (options.runner ?? runAislop)(request);
	if (options.failOnError !== false && !result.skipped && result.exitCode !== 0) throw new Error(`aislop ${request.args.join(" ")} failed for ${framework} with exit code ${String(result.exitCode)}`);
	return result;
};
const createAislopPackageScripts = (_framework, options = {}) => {
	const scripts = {
		"aislop:scan": "aislop scan",
		"aislop:ci": `aislop ${options.command ?? "ci"}`
	};
	if (options.includeAgent ?? true) scripts["aislop:agent"] = "aislop agent";
	if (options.includeHook ?? true) scripts["aislop:hook"] = "aislop hook install";
	return scripts;
};
const createAislopCiWorkflow = (packageManagerCommand = "npx --yes aislop@latest ci") => [
	"name: aislop",
	"",
	"on:",
	"  pull_request:",
	"  push:",
	"    branches: [main]",
	"",
	"jobs:",
	"  quality-gate:",
	"    runs-on: ubuntu-latest",
	"    steps:",
	"      - uses: actions/checkout@v4",
	`      - run: ${packageManagerCommand}`,
	""
].join("\n");
//#endregion
export { createAislopPackageScripts as n, maybeRunAislop as r, createAislopCiWorkflow as t };
