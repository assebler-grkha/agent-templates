//#region src/framework-adapters/core.d.ts
type AislopFramework = "astro" | "expo" | "nuxt" | "sveltekit" | "vite" | "tanstack-start" | "redwoodsdk" | "t3";
type AislopAdapterCommand = "ci" | "scan";
interface AislopRunRequest {
  framework: AislopFramework;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
interface AislopRunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  skipped: boolean;
}
type AislopRunner = (request: AislopRunRequest) => AislopRunResult | Promise<AislopRunResult>;
interface AislopAdapterOptions {
  /**
   * Running during a framework build is opt-in so integrations never surprise
   * local dev servers or production builds.
   */
  enabled?: boolean;
  command?: AislopAdapterCommand;
  args?: string[];
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  failOnError?: boolean;
  runner?: AislopRunner;
}
//#endregion
export { AislopFramework as n, AislopRunResult as r, AislopAdapterOptions as t };