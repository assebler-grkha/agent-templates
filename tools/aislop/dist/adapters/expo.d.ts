import { r as AislopRunResult, t as AislopAdapterOptions } from "../core-Cd1J69dD.js";
//#region src/framework-adapters/expo.d.ts
interface ExpoConfigLike {
  extra?: Record<string, unknown>;
  [name: string]: unknown;
}
interface AislopExpoOptions extends AislopAdapterOptions {
  /**
   * Expo config plugins run while resolving app config. Keep scan execution out
   * of that path unless a host integration explicitly opts in.
   */
  runDuringConfig?: boolean;
}
declare const createExpoAislopScripts: () => Record<string, string>;
declare const createExpoAislopWorkflow: () => string;
declare const runExpoAislop: (options?: AislopExpoOptions) => Promise<AislopRunResult>;
declare const withAislopExpo: <TConfig extends ExpoConfigLike>(config: TConfig, _options?: AislopExpoOptions) => TConfig;
//#endregion
export { AislopExpoOptions, ExpoConfigLike, createExpoAislopScripts, createExpoAislopWorkflow, withAislopExpo as default, runExpoAislop };