//#region src/output/engine-info.ts
const ENGINE_INFO = {
	format: {
		label: "Formatting",
		description: "Whitespace, indentation, line wrapping, and import ordering"
	},
	lint: {
		label: "Linting",
		description: "Static analysis for likely bugs and bad patterns"
	},
	"code-quality": {
		label: "Code Quality",
		description: "Complexity limits, dead code detection, and duplication checks"
	},
	"ai-slop": {
		label: "AI Slop",
		description: "Narrative comments, dead patterns, unsafe type casts, TODO stubs, generic names"
	},
	architecture: {
		label: "Architecture",
		description: "Project-specific import and layering rules"
	},
	security: {
		label: "Security",
		description: "Secret leaks, risky APIs, and dependency vulnerabilities"
	}
};
const getEngineLabel = (engine) => ENGINE_INFO[engine].label;
//#endregion
//#region src/scoring/rule-impact-builders.ts
const strict = (rationale) => ({
	tier: "strict",
	multiplier: 1,
	rationale
});
const standard = (rationale) => ({
	tier: "standard",
	multiplier: 1,
	rationale
});
const maintainability = (rationale, cap = 24) => ({
	tier: "maintainability",
	multiplier: .75,
	cap,
	rationale
});
const mechanical = (rationale, cap = 16) => ({
	tier: "mechanical",
	multiplier: .5,
	cap,
	rationale
});
const style = (rationale, cap = 8) => ({
	tier: "style",
	multiplier: .5,
	cap,
	rationale
});
const advisory = (rationale, cap = 8) => ({
	tier: "advisory",
	multiplier: .25,
	cap,
	rationale
});
//#endregion
//#region src/scoring/rule-impact-ai-slop.ts
const AI_SLOP_RULE_SCORE_IMPACTS = {
	"ai-slop/trivial-comment": style("Restating comments are style noise; keep the finding visible but score gently."),
	"ai-slop/swallowed-exception": strict("Swallowed failures hide real broken states and deserve full scoring impact."),
	"ai-slop/silent-recovery": strict("Logging/defaulting and continuing can corrupt behavior unless handled intentionally."),
	"ai-slop/meta-comment": style("Process narration is cleanup noise and should not make a healthy repo look broken."),
	"ai-slop/hidden-fallback": maintainability("Safe-looking defaults that hide missing or failed state deserve explicit review."),
	"ai-slop/redundant-try-catch": maintainability("Redundant error plumbing adds noise but is usually not a runtime defect."),
	"ai-slop/redundant-type-coercion": maintainability("Redundant coercion is cleanup and readability debt."),
	"ai-slop/duplicate-type-declaration": maintainability("Duplicate types create drift risk but usually need intentional consolidation."),
	"ai-slop/thin-wrapper": maintainability("Thin wrappers add abstraction debt without usually changing behavior."),
	"ai-slop/generic-naming": advisory("Vague names are weak signals and often subjective."),
	"ai-slop/unused-import": mechanical("Unused imports are mechanical cleanup."),
	"ai-slop/unused-css": style("Dead CSS classes are cleanup, not correctness bugs, and dynamic usage can make detection lower-confidence."),
	"ai-slop/console-leftover": style("Leftover debug output is visible cleanup unless it leaks sensitive data."),
	"ai-slop/todo-stub": standard("Unresolved TODO/stub markers often indicate unfinished behavior."),
	"ai-slop/unmarked-debt": standard("Unmarked mock data, stubs, or localhost URLs require AGENT:* tracking tags."),
	"ai-slop/unreachable-code": strict("Unreachable code is a high-confidence logic defect."),
	"ai-slop/constant-condition": strict("Constant conditions usually indicate broken branches."),
	"ai-slop/empty-function": standard("Empty functions may be intentional shims, but often indicate placeholder behavior."),
	"ai-slop/unsafe-type-assertion": maintainability("Unsafe casts bypass type checks and can hide real data-shape bugs."),
	"ai-slop/double-type-assertion": strict("Double assertions deliberately force types through unknown/any and deserve strong impact."),
	"ai-slop/ts-directive": style("TypeScript suppressions need review, but individual directives can be intentional debt."),
	"ai-slop/narrative-comment": style("Narrative comments are cleanup/style findings rather than defects."),
	"ai-slop/duplicate-import": mechanical("Duplicate imports are mechanical cleanup."),
	"ai-slop/hardcoded-url": advisory("Hardcoded URLs are medium-confidence config signals and can be intentional canonical URLs.", 4),
	"ai-slop/hardcoded-id": advisory("Hardcoded provider IDs are config signals, but not all IDs are equally risky.", 4),
	"ai-slop/python-bare-except": strict("Bare except catches system exits and hides real failures."),
	"ai-slop/python-broad-except": standard("Broad exception handling is risky but sometimes intentional at boundaries."),
	"ai-slop/python-mutable-default": strict("Mutable defaults are a high-confidence Python behavior bug."),
	"ai-slop/python-print-debug": style("Debug print output is cleanup unless it leaks sensitive data."),
	"ai-slop/python-range-len-loop": advisory("Index loops are style/readability signals and often not harmful."),
	"ai-slop/python-chained-dict-get": maintainability("Chained dict fallback hides shape assumptions and deserves review."),
	"ai-slop/python-repetitive-dispatch": maintainability("Repetitive dispatch ladders create maintainability debt."),
	"ai-slop/python-isinstance-ladder": maintainability("Long isinstance ladders are brittle polymorphism but not immediate defects."),
	"ai-slop/go-library-panic": maintainability("Go panics in libraries deserve review, but compiler/runtime invariants and test helpers make this lower-confidence than a confirmed defect."),
	"ai-slop/rust-non-test-unwrap": strict("Production unwrap can panic instead of handling expected failure."),
	"ai-slop/rust-todo-stub": standard("Rust todo/unimplemented stubs represent unfinished behavior."),
	"ai-slop/hallucinated-import": strict("Imports missing from the manifest are high-confidence install/runtime failures."),
	"ai-slop/tautological-test": standard("Literal-success assertions are high-confidence test gaps but do not break production directly."),
	"ai-slop/csharp-not-implemented": standard("NotImplementedException stubs usually indicate unfinished behavior."),
	"ai-slop/csharp-async-void": standard("async void can't be awaited and its exceptions crash the process."),
	"ai-slop/csharp-sync-over-async": standard("Blocking on a Task with .Result/.Wait() risks deadlock and burns a thread."),
	"ai-slop/csharp-suppressed-warning": maintainability("Unjustified warning suppression hides analyzer findings rather than fixing them."),
	"ai-slop/csharp-empty-catch-rethrow": mechanical("catch (...) { throw; } is pure noise with no behavior change - mechanical cleanup."),
	"ai-slop/csharp-null-forgiving": maintainability("The null-forgiving ! silences nullable safety without proving the value is non-null."),
	"ai-slop/csharp-console-leftover": style("Leftover Console/Debug/Trace output is visible cleanup unless it leaks sensitive data."),
	"ai-slop/csharp-redundant-doc-comment": style("XML-doc that restates the member name is a cleanup/style finding, not a defect."),
	"ai-slop/csharp-broad-catch": standard("catch (Exception) buries specific failures, though it is sometimes intentional at boundaries."),
	"ai-slop/csharp-linq-count": advisory("Comparing .Count() to 0/1 is a readability/perf idiom signal, often harmless."),
	"ai-slop/csharp-index-loop": advisory("Index for-loops over .Length/.Count are style/readability signals, often not harmful."),
	"ai-slop/csharp-if-ladder": maintainability("Repeated if/else-if ladders dispatching on one value create maintainability debt."),
	"ai-slop/csharp-string-concat-in-loop": maintainability("Repeated string += in a loop is O(n^2) allocation churn; a StringBuilder is the fix."),
	"ai-slop/cpp-not-implemented": standard("Stubs that throw or assert 'not implemented' usually indicate unfinished behavior."),
	"ai-slop/cpp-using-namespace-std-in-header": maintainability("A using-directive at header scope leaks std names into every includer, a hygiene debt."),
	"ai-slop/cpp-c-style-cast": style("A C-style cast in C++ is a cleanup/style finding; a named cast makes intent explicit."),
	"ai-slop/cpp-manual-delete": maintainability("Manual delete is a memory-safety hazard; RAII/smart pointers own the resource instead."),
	"ai-slop/cpp-iostream-leftover": style("Leftover std::cout/std::cerr in library code is visible cleanup unless it leaks data."),
	"ai-slop/cpp-null-literal": style("NULL versus nullptr is a modernization/style finding; nullptr avoids integer-overload pitfalls."),
	"ai-slop/cpp-define-constant": style("A macro constant instead of constexpr is a style/hygiene finding, not a behavior bug."),
	"ai-slop/cpp-endl-in-stream": style("std::endl versus '\\n' is a minor performance/style finding from redundant flushes.")
};
//#endregion
//#region src/scoring/rule-impact.ts
const RULE_SCORE_IMPACTS = {
	formatting: mechanical("Formatter output is mechanical cleanup.", 12),
	"import-order": mechanical("Import ordering is mechanical cleanup.", 12),
	"python-formatting": mechanical("Python formatter output is mechanical cleanup.", 12),
	"go-formatting": mechanical("Go formatter output is mechanical cleanup.", 12),
	"rust-formatting": mechanical("Rust formatter output is mechanical cleanup.", 12),
	"ruby-formatting": mechanical("Ruby formatter output is mechanical cleanup.", 12),
	"php-formatting": mechanical("PHP formatter output is mechanical cleanup.", 12),
	"csharp-formatting": mechanical("C# formatter output is mechanical cleanup.", 12),
	"code-quality/duplicate-block": maintainability("Large copy-paste blocks are real maintenance debt, but repeated blocks are less severe than defects."),
	"code-quality/repeated-chained-call": maintainability("Repeated call chains hurt readability and change safety without usually being runtime defects."),
	"code-quality/unused-declaration": mechanical("Unused declarations are cleanup work and often removable, so they should not dominate the score."),
	"complexity/file-too-large": style("Large files are reviewability pressure, but size alone is not a confirmed defect."),
	"complexity/function-too-long": style("Long functions are maintainability pressure, but length alone is not a confirmed defect."),
	"complexity/deep-nesting": maintainability("Deep nesting makes behavior harder to reason about and is more actionable than pure size."),
	"complexity/too-many-params": maintainability("Large parameter lists hurt call-site safety but usually need intentional refactoring."),
	"knip/files": mechanical("Unused files are cleanup work and can repeat heavily in stale repos."),
	"knip/dependencies": mechanical("Unused production dependencies are cleanup and supply-chain surface, but usually mechanical."),
	"knip/devDependencies": mechanical("Unused dev dependencies are low-risk cleanup."),
	"knip/unlisted": strict("A used package missing from the manifest can break installs and CI."),
	"knip/unresolved": strict("An unresolved import is a high-confidence build/runtime failure."),
	"knip/binaries": mechanical("Unused package binaries are manifest cleanup."),
	"knip/exports": mechanical("Unused exports are public-surface cleanup and can be noisy in libraries."),
	"knip/types": mechanical("Unused exported types are low-risk cleanup."),
	"knip/duplicates": maintainability("Duplicate exports are real API hygiene issues."),
	"security/hardcoded-secret": strict("Secret-looking source literals are high-risk."),
	"security/vulnerable-dependency": strict("Known vulnerabilities deserve full impact even when remediation varies."),
	"security/eval": strict("Dynamic code execution can run attacker-controlled input."),
	"security/innerhtml": strict("Raw HTML assignment can become XSS."),
	"security/dangerously-set-innerhtml": strict("React raw HTML escape hatches can become XSS."),
	"security/sql-injection": strict("Interpolated SQL can become data exfiltration or mutation."),
	"security/shell-injection": strict("Interpolated shell commands can become command execution."),
	"security/unsafe-deserialization": strict("Deserializing untrusted data with a legacy .NET formatter can become remote code execution."),
	"security/unsafe-c-call": strict("Unbounded C string and process calls can become buffer overflows or command execution."),
	"security/dependency-audit-skipped": advisory("An unavailable audit is visibility loss, not evidence of a vulnerability."),
	"dotnet/projects-skipped": advisory("Skipping unrestored C# projects is visibility loss, not evidence of a defect."),
	"cppcheck/chunks-skipped": advisory("A skipped cppcheck chunk is visibility loss, not evidence that the skipped files have a defect."),
	"eslint/no-undef": strict("Undefined identifiers are high-confidence runtime failures."),
	"eslint/no-unused-vars": mechanical("Unused variables are mechanical cleanup."),
	"eslint/no-unassigned-vars": strict("Variables that are never assigned point to broken logic."),
	"eslint/no-empty": style("Empty blocks can be intentional placeholders but should be reviewed."),
	"eslint/no-useless-escape": mechanical("Useless escapes are mechanical cleanup."),
	"eslint/no-unused-expressions": maintainability("Unused expressions often indicate dropped logic."),
	"eslint/no-shadow-restricted-names": strict("Shadowing restricted names can break runtime behavior."),
	"eslint/no-constant-binary-expression": strict("Constant binary expressions usually indicate broken conditions."),
	"eslint/no-unsafe-optional-chaining": strict("Unsafe optional chaining can throw at runtime."),
	"eslint/require-yield": maintainability("Generators without yield are API-shape mistakes."),
	"import/no-duplicates": mechanical("Duplicate import paths are mechanical cleanup."),
	"import/default": strict("Missing default exports can break module loading."),
	"import/named": strict("Missing named exports can break module loading."),
	"import/namespace": strict("Invalid namespace imports can break module loading."),
	"typescript-eslint/triple-slash-reference": mechanical("Triple-slash references are usually cleanup in modern TypeScript projects."),
	"unicorn/no-useless-fallback-in-spread": maintainability("Useless fallbacks add noise."),
	"unicorn/prefer-string-starts-ends-with": mechanical("String predicate preferences are mechanical readability cleanup."),
	"unicorn/no-invalid-remove-event-listener": strict("Invalid event listener removal can leave behavior broken."),
	"unicorn/no-empty-file": mechanical("Empty files are cleanup work."),
	"unicorn/no-useless-length-check": maintainability("Useless length checks add dead branches."),
	"unicorn/no-new-array": maintainability("Avoiding new Array prevents sparse-array mistakes."),
	"unicorn/no-useless-spread": maintainability("Useless spreads add noise and allocation."),
	"unicorn/no-single-promise-in-promise-methods": maintainability("Single-element Promise combinators add unnecessary structure."),
	...AI_SLOP_RULE_SCORE_IMPACTS
};
const DEFAULT_IMPACT = standard("Unclassified external rule uses standard impact.");
const WILDCARD_RULE_SCORE_IMPACTS = [
	["oxlint/", standard("External oxlint rule uses standard lint impact.")],
	["ruff/", standard("External ruff rule uses standard lint impact.")],
	["go/", standard("External Go lint rule uses standard lint impact.")],
	["clippy/", standard("External clippy rule uses standard lint impact.")],
	["rubocop/", standard("External rubocop rule uses standard lint impact.")],
	["typescript/", strict("TypeScript compiler diagnostics can break builds.")],
	["expo-doctor/", maintainability("Expo Doctor findings are project-configuration hygiene.")]
];
const scoreImpactForRule = (ruleId) => RULE_SCORE_IMPACTS[ruleId] ?? WILDCARD_RULE_SCORE_IMPACTS.find(([prefix]) => ruleId.startsWith(prefix))?.[1] ?? DEFAULT_IMPACT;
//#endregion
//#region src/output/finding-assessment.ts
const KNIP_FORCE_RULES = /* @__PURE__ */ new Set([
	"knip/files",
	"knip/dependencies",
	"knip/devDependencies"
]);
const isForceFixable = (diagnostic) => {
	if (diagnostic.fixable) return false;
	if (KNIP_FORCE_RULES.has(diagnostic.rule)) return true;
	if (diagnostic.rule === "security/vulnerable-dependency") return diagnostic.detail === "npm" || diagnostic.detail === "pnpm";
	if (diagnostic.rule.startsWith("expo-doctor/")) return diagnostic.rule !== "expo-doctor/config-error";
	return false;
};
const FINDING_KIND_LABELS = {
	"confirmed-defect": "confirmed defects",
	"conservative-security": "conservative security",
	"style-policy": "style/policy",
	"ai-slop-indicator": "AI-slop indicators"
};
const STYLE_POLICY_RULES = /* @__PURE__ */ new Set([
	"ai-slop/trivial-comment",
	"ai-slop/narrative-comment",
	"ai-slop/meta-comment",
	"ai-slop/console-leftover",
	"ai-slop/ts-directive",
	"complexity/file-too-large",
	"complexity/function-too-long",
	"complexity/deep-nesting",
	"complexity/too-many-params",
	"code-quality/duplicate-block",
	"eslint/no-empty",
	"eslint/no-unused-vars",
	"eslint/no-useless-escape",
	"eslint/no-unused-expressions",
	"unicorn/no-useless-fallback-in-spread",
	"unicorn/prefer-string-starts-ends-with",
	"unicorn/no-new-array",
	"unicorn/no-useless-spread"
]);
const CONFIRMED_DEFECT_RULES = /* @__PURE__ */ new Set([
	"ai-slop/hallucinated-import",
	"eslint/no-undef",
	"eslint/no-unreachable",
	"security/vulnerable-dependency"
]);
const LOW_CONFIDENCE_SECURITY_RULES = /* @__PURE__ */ new Set(["security/innerhtml", "security/dangerously-set-innerhtml"]);
const confidenceFor = (diagnostic, kind) => {
	if (kind === "confirmed-defect") return "high";
	if (kind === "style-policy") return "medium";
	if (kind === "conservative-security") {
		if (LOW_CONFIDENCE_SECURITY_RULES.has(diagnostic.rule)) return "medium";
		return diagnostic.severity === "error" ? "high" : "medium";
	}
	return diagnostic.severity === "error" ? "high" : "medium";
};
const classifyKind = (diagnostic) => {
	if (CONFIRMED_DEFECT_RULES.has(diagnostic.rule)) return "confirmed-defect";
	if (diagnostic.engine === "security") return "conservative-security";
	if (STYLE_POLICY_RULES.has(diagnostic.rule)) return "style-policy";
	if (diagnostic.engine === "format" || diagnostic.engine === "code-quality") return "style-policy";
	if (diagnostic.engine === "ai-slop") return "ai-slop-indicator";
	if (diagnostic.severity === "error") return "confirmed-defect";
	return "style-policy";
};
const assessDiagnostic = (diagnostic) => {
	const kind = classifyKind(diagnostic);
	return {
		kind,
		confidence: confidenceFor(diagnostic, kind),
		label: FINDING_KIND_LABELS[kind]
	};
};
const withFindingAssessments = (diagnostics) => diagnostics.map((diagnostic) => ({
	...diagnostic,
	assessment: assessDiagnostic(diagnostic),
	scoreImpact: scoreImpactForRule(diagnostic.rule),
	forceFixable: isForceFixable(diagnostic)
}));
const summarizeFindingAssessments = (diagnostics) => {
	const byKind = {
		"confirmed-defect": 0,
		"conservative-security": 0,
		"style-policy": 0,
		"ai-slop-indicator": 0
	};
	const byConfidence = {
		high: 0,
		medium: 0,
		low: 0
	};
	const rows = /* @__PURE__ */ new Map();
	for (const diagnostic of diagnostics) {
		const assessment = assessDiagnostic(diagnostic);
		byKind[assessment.kind]++;
		byConfidence[assessment.confidence]++;
		const row = rows.get(assessment.kind) ?? {
			kind: assessment.kind,
			label: assessment.label,
			count: 0,
			errors: 0,
			warnings: 0,
			info: 0,
			fixable: 0
		};
		row.count++;
		if (diagnostic.severity === "error") row.errors++;
		else if (diagnostic.severity === "warning") row.warnings++;
		else row.info++;
		if (diagnostic.fixable) row.fixable++;
		rows.set(assessment.kind, row);
	}
	return {
		rows: [...rows.values()].sort((a, b) => b.count - a.count),
		byKind,
		byConfidence
	};
};
//#endregion
export { getEngineLabel as a, ENGINE_INFO as i, withFindingAssessments as n, scoreImpactForRule as r, summarizeFindingAssessments as t };
