import { n as createAislopPackageScripts, r as maybeRunAislop, t as createAislopCiWorkflow } from "../core-D4295PVP.js";
//#region src/framework-adapters/expo.ts
const createExpoAislopScripts = () => createAislopPackageScripts("expo");
const createExpoAislopWorkflow = () => createAislopCiWorkflow();
const runExpoAislop = async (options = {}) => maybeRunAislop("expo", {
	...options,
	enabled: options.enabled ?? options.runDuringConfig ?? false
});
const withAislopExpo = (config, _options = {}) => {
	const extra = {
		...config.extra,
		aislop: {
			command: "npx --yes aislop@latest ci",
			hook: "aislop hook install",
			enabled: true
		}
	};
	return {
		...config,
		extra
	};
};
//#endregion
export { createExpoAislopScripts, createExpoAislopWorkflow, withAislopExpo as default, runExpoAislop };
