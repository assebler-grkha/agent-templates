import { n as createAislopPackageScripts, r as maybeRunAislop, t as createAislopCiWorkflow } from "../core-D4295PVP.js";
//#region src/framework-adapters/astro.ts
const createAstroAislopScripts = () => createAislopPackageScripts("astro");
const createAstroAislopWorkflow = () => createAislopCiWorkflow();
const runAstroAislop = async (options = {}) => maybeRunAislop("astro", {
	...options,
	enabled: options.enabled ?? options.runOnBuild ?? false
});
const aislopAstro = (options = {}) => ({
	name: "@scanaislop/astro",
	hooks: { "astro:build:start": async () => {
		await runAstroAislop(options);
	} }
});
//#endregion
export { createAstroAislopScripts, createAstroAislopWorkflow, aislopAstro as default, runAstroAislop };
