import { r as AislopRunResult, t as AislopAdapterOptions } from "../core-Cd1J69dD.js";
//#region src/framework-adapters/astro.d.ts
interface AstroIntegration {
  name: string;
  hooks: {
    "astro:build:start"?: () => Promise<void>;
  };
}
interface AislopAstroOptions extends AislopAdapterOptions {
  runOnBuild?: boolean;
}
declare const createAstroAislopScripts: () => Record<string, string>;
declare const createAstroAislopWorkflow: () => string;
declare const runAstroAislop: (options?: AislopAstroOptions) => Promise<AislopRunResult>;
declare const aislopAstro: (options?: AislopAstroOptions) => AstroIntegration;
//#endregion
export { AislopAstroOptions, AstroIntegration, createAstroAislopScripts, createAstroAislopWorkflow, aislopAstro as default, runAstroAislop };