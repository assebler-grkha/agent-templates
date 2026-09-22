import { n as createAislopPackageScripts, t as createAislopCiWorkflow } from "../core-D4295PVP.js";
import aislopVite, { runViteAislop } from "./vite.js";
//#region src/framework-adapters/sveltekit.ts
const createSvelteKitAislopScripts = () => createAislopPackageScripts("sveltekit");
const createSvelteKitAislopWorkflow = () => createAislopCiWorkflow();
const runSvelteKitAislop = async (options = {}) => runViteAislop({
	...options,
	framework: "sveltekit"
});
const aislopSvelteKit = (options = {}) => aislopVite({
	...options,
	framework: "sveltekit"
});
//#endregion
export { createSvelteKitAislopScripts, createSvelteKitAislopWorkflow, aislopSvelteKit as default, runSvelteKitAislop };
