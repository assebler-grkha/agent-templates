import { r as AislopRunResult, t as AislopAdapterOptions } from "../core-Cd1J69dD.js";
//#region src/framework-adapters/nuxt.d.ts
type NuxtHookName = "build:before" | "nitro:build:before";
interface NuxtLike {
  hook?: (name: NuxtHookName, callback: () => Promise<void>) => void;
  options?: {
    runtimeConfig?: Record<string, unknown>;
  };
}
interface AislopNuxtOptions extends AislopAdapterOptions {
  runOnBuild?: boolean;
  hook?: NuxtHookName;
}
interface NuxtModuleLike {
  meta: {
    name: string;
    configKey: string;
  };
  defaults: AislopNuxtOptions;
  setup: (options: AislopNuxtOptions, nuxt: NuxtLike) => void | Promise<void>;
}
declare const createNuxtAislopScripts: () => Record<string, string>;
declare const createNuxtAislopWorkflow: () => string;
declare const runNuxtAislop: (options?: AislopNuxtOptions) => Promise<AislopRunResult>;
declare const createAislopNuxtModule: (defaults?: AislopNuxtOptions) => NuxtModuleLike;
declare const _default: NuxtModuleLike;
//#endregion
export { AislopNuxtOptions, NuxtLike, NuxtModuleLike, createAislopNuxtModule, createNuxtAislopScripts, createNuxtAislopWorkflow, _default as default, runNuxtAislop };