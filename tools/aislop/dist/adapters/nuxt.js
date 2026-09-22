import { n as createAislopPackageScripts, r as maybeRunAislop, t as createAislopCiWorkflow } from "../core-D4295PVP.js";
//#region src/framework-adapters/nuxt.ts
const DEFAULTS = {
	command: "ci",
	enabled: false,
	failOnError: true,
	hook: "build:before"
};
const createNuxtAislopScripts = () => createAislopPackageScripts("nuxt");
const createNuxtAislopWorkflow = () => createAislopCiWorkflow();
const runNuxtAislop = async (options = {}) => maybeRunAislop("nuxt", {
	...options,
	enabled: options.enabled ?? options.runOnBuild ?? false
});
const createAislopNuxtModule = (defaults = {}) => ({
	meta: {
		name: "@scanaislop/nuxt",
		configKey: "aislop"
	},
	defaults: {
		...DEFAULTS,
		...defaults
	},
	setup(options, nuxt) {
		const merged = {
			...DEFAULTS,
			...defaults,
			...options
		};
		nuxt.hook?.(merged.hook ?? "build:before", async () => {
			await runNuxtAislop(merged);
		});
	}
});
var nuxt_default = createAislopNuxtModule();
//#endregion
export { createAislopNuxtModule, createNuxtAislopScripts, createNuxtAislopWorkflow, nuxt_default as default, runNuxtAislop };
