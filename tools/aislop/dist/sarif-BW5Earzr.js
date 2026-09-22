#!/usr/bin/env node
import { i as APP_VERSION } from "./cli.js";
import path from "node:path";
//#region src/output/sarif.ts
const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
const levelFromSeverity = (severity) => {
	if (severity === "error") return "error";
	if (severity === "warning") return "warning";
	return "note";
};
const oneBased = (value) => value >= 1 ? value : 1;
const toUri = (filePath) => filePath.split(path.sep).join("/");
const buildRules = (diagnostics) => {
	const byId = /* @__PURE__ */ new Map();
	for (const d of diagnostics) {
		if (byId.has(d.rule)) continue;
		byId.set(d.rule, {
			id: d.rule,
			name: d.rule,
			shortDescription: { text: d.message },
			help: { text: d.help || d.message }
		});
	}
	return [...byId.values()];
};
const buildSarifLog = (results) => {
	const diagnostics = results.flatMap((r) => r.diagnostics);
	const rules = buildRules(diagnostics);
	const ruleIndex = new Map(rules.map((rule, index) => [rule.id, index]));
	const sarifResults = diagnostics.map((d) => ({
		ruleId: d.rule,
		ruleIndex: ruleIndex.get(d.rule) ?? 0,
		level: levelFromSeverity(d.severity),
		message: { text: d.message },
		locations: [{ physicalLocation: {
			artifactLocation: { uri: toUri(d.filePath) },
			region: {
				startLine: oneBased(d.line),
				startColumn: oneBased(d.column)
			}
		} }],
		...d.changeContext ? { properties: { changeContext: d.changeContext } } : {}
	}));
	return {
		$schema: SARIF_SCHEMA,
		version: SARIF_VERSION,
		runs: [{
			tool: { driver: {
				name: "aislop",
				version: APP_VERSION,
				informationUri: "https://github.com/scanaislop/aislop",
				rules
			} },
			results: sarifResults
		}]
	};
};
//#endregion
export { buildSarifLog };
