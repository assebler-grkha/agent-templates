#!/usr/bin/env node
import { Box, Text, useInput, useStdout } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
import SelectInput from "ink-select-input";
import { useEffect, useState } from "react";
//#region src/ui/agent-tui/ActivityPane.tsx
const colorFor$1 = (kind) => {
	if (kind === "tool") return "cyan";
	if (kind === "exec") return "yellow";
	if (kind === "event") return "gray";
	return "white";
};
const prefixFor = (kind) => kind === "assistant" ? "" : `${kind} `;
const ActivityPane = ({ activity, rows }) => {
	return /* @__PURE__ */ jsx(Box, {
		flexDirection: "column",
		flexGrow: 1,
		paddingX: 1,
		children: activity.slice(-Math.max(1, rows)).map((line, index) => /* @__PURE__ */ jsxs(Text, {
			color: colorFor$1(line.kind),
			wrap: "truncate-end",
			children: [/* @__PURE__ */ jsx(Text, {
				dimColor: true,
				children: prefixFor(line.kind)
			}), line.text]
		}, `${line.at}-${index}`))
	});
};
//#endregion
//#region src/ui/agent-tui/DecisionBar.tsx
const DecisionBar = ({ decision }) => {
	const items = decision.options.map((option) => ({
		label: option.hint ? `${option.label}  (${option.hint})` : option.label,
		value: option.value
	}));
	return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		paddingX: 1,
		borderStyle: "round",
		borderColor: "cyan",
		children: [/* @__PURE__ */ jsx(Text, {
			bold: true,
			children: decision.question
		}), /* @__PURE__ */ jsx(SelectInput, {
			items,
			onSelect: (item) => decision.resolve(item.value)
		})]
	});
};
//#endregion
//#region src/ui/agent-tui/FilesPanel.tsx
const DiffStat = ({ file }) => {
	if (file.binary) return /* @__PURE__ */ jsx(Text, {
		dimColor: true,
		children: "binary"
	});
	if (typeof file.additions === "number" || typeof file.deletions === "number") return /* @__PURE__ */ jsxs(Text, { children: [
		/* @__PURE__ */ jsxs(Text, {
			color: "green",
			children: ["+", file.additions ?? 0]
		}),
		" ",
		/* @__PURE__ */ jsxs(Text, {
			color: "red",
			children: ["-", file.deletions ?? 0]
		})
	] });
	return /* @__PURE__ */ jsx(Text, {
		dimColor: true,
		children: "changed"
	});
};
const FilesPanel = ({ files }) => {
	if (files.length === 0) return null;
	const shown = files.slice(-5);
	return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		paddingX: 1,
		children: [
			/* @__PURE__ */ jsx(Text, {
				dimColor: true,
				children: "Edited files"
			}),
			shown.map((file) => /* @__PURE__ */ jsxs(Text, {
				wrap: "truncate-middle",
				children: [
					/* @__PURE__ */ jsx(Text, {
						color: "green",
						children: "✓ "
					}),
					file.filePath,
					" ",
					/* @__PURE__ */ jsx(DiffStat, { file })
				]
			}, file.filePath)),
			files.length > shown.length ? /* @__PURE__ */ jsxs(Text, {
				dimColor: true,
				children: [
					"+",
					files.length - shown.length,
					" more"
				]
			}) : null
		]
	});
};
//#endregion
//#region src/ui/agent-tui/FooterBar.tsx
const FooterBar = ({ repo, branch, worktree }) => /* @__PURE__ */ jsxs(Box, {
	paddingX: 1,
	justifyContent: "space-between",
	children: [/* @__PURE__ */ jsxs(Text, {
		dimColor: true,
		wrap: "truncate-middle",
		children: [
			repo,
			branch ? `  ${branch}` : "",
			worktree ? `  ↳ ${worktree}` : ""
		]
	}), /* @__PURE__ */ jsx(Text, {
		dimColor: true,
		children: "ctrl+c to quit"
	})]
});
//#endregion
//#region src/agents/pricing.ts
const MODELS = {
	"gpt-5.4": {
		model: "gpt-5.4",
		inPerMTok: 1.25,
		outPerMTok: 10,
		contextWindow: 4e5
	},
	"claude-opus-4-8": {
		model: "claude-opus-4-8",
		inPerMTok: 5,
		outPerMTok: 25,
		contextWindow: 2e5
	},
	"claude-sonnet-4-6": {
		model: "claude-sonnet-4-6",
		inPerMTok: 3,
		outPerMTok: 15,
		contextWindow: 2e5
	}
};
const PROVIDER_DEFAULT = {
	codex: "gpt-5.4",
	claude: "claude-opus-4-8",
	opencode: "claude-sonnet-4-6"
};
const resolvePricing = (provider, model) => {
	if (model && MODELS[model]) return MODELS[model];
	const fallback = PROVIDER_DEFAULT[provider.toLowerCase()];
	return fallback ? MODELS[fallback] ?? null : null;
};
const computeCostUsd = (pricing, tokens) => {
	if (!pricing) return null;
	return tokens.in / 1e6 * pricing.inPerMTok + tokens.out / 1e6 * pricing.outPerMTok;
};
//#endregion
//#region src/ui/agent-tui/format.ts
const fmtTokens = (n) => {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
	return String(n);
};
const fmtElapsed = (ms) => {
	const totalSeconds = Math.round(ms / 1e3);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
};
//#endregion
//#region src/ui/agent-tui/Sidebar.tsx
const Row = ({ label, value, color }) => /* @__PURE__ */ jsxs(Box, { children: [/* @__PURE__ */ jsx(Box, {
	width: 9,
	children: /* @__PURE__ */ jsx(Text, {
		dimColor: true,
		children: label
	})
}), /* @__PURE__ */ jsx(Text, {
	color,
	children: value
})] });
const scoreColor = (score, target) => {
	if (score == null) return "white";
	if (score >= target) return "green";
	if (score >= target * .7) return "yellow";
	return "red";
};
const useElapsedSince = (startedAt) => {
	const [now, setNow] = useState(startedAt);
	useEffect(() => {
		const tick = () => setNow(Date.now());
		tick();
		const timer = setInterval(tick, 1e3);
		return () => clearInterval(timer);
	}, []);
	return Math.max(0, now - startedAt);
};
const Sidebar = ({ state }) => {
	const elapsed = useElapsedSince(state.startedAt);
	const pricing = resolvePricing(state.provider, state.model);
	const cost = state.usage?.costUsd ?? computeCostUsd(pricing, state.tokens);
	const ctx = pricing ? state.tokens.in / pricing.contextWindow * 100 : null;
	const hasUsage = state.tokens.total > 0;
	return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		width: 30,
		alignSelf: "flex-start",
		paddingX: 1,
		borderStyle: "round",
		borderColor: "gray",
		children: [/* @__PURE__ */ jsx(Text, {
			bold: true,
			children: state.model ? `${state.provider} · ${state.model}` : state.provider
		}), /* @__PURE__ */ jsxs(Box, {
			marginTop: 1,
			flexDirection: "column",
			children: [
				/* @__PURE__ */ jsx(Row, {
					label: "Score",
					value: state.score != null && state.score >= state.targetScore ? `${state.score} ✓` : `${state.score ?? "--"} → ${state.targetScore}`,
					color: scoreColor(state.score, state.targetScore)
				}),
				/* @__PURE__ */ jsx(Row, {
					label: "Left",
					value: state.findingsRemaining == null ? "--" : String(state.findingsRemaining)
				}),
				/* @__PURE__ */ jsx(Row, {
					label: "Files",
					value: String(state.filesChanged.size)
				}),
				/* @__PURE__ */ jsx(Row, {
					label: "Passes",
					value: String(state.passes)
				}),
				/* @__PURE__ */ jsx(Row, {
					label: "Tokens",
					value: hasUsage ? fmtTokens(state.tokens.total) : state.estimatedTokens > 0 ? `~${fmtTokens(state.estimatedTokens)}` : "--"
				}),
				hasUsage && cost != null ? /* @__PURE__ */ jsx(Row, {
					label: "Cost",
					value: `$${cost.toFixed(2)}`
				}) : null,
				hasUsage && ctx != null ? /* @__PURE__ */ jsx(Row, {
					label: "Context",
					value: `${Math.round(ctx)}%`
				}) : null,
				/* @__PURE__ */ jsx(Row, {
					label: "Elapsed",
					value: fmtElapsed(elapsed)
				})
			]
		})]
	});
};
//#endregion
//#region src/ui/agent-tui/Spinner.tsx
const FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
const Spinner = ({ color }) => {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
		return () => clearInterval(timer);
	}, []);
	return /* @__PURE__ */ jsx(Text, {
		color,
		children: FRAMES[frame]
	});
};
//#endregion
//#region src/ui/agent-tui/StepsPanel.tsx
const glyph = (status) => {
	if (status === "done") return "✓";
	if (status === "warn") return "!";
	if (status === "failed") return "✗";
	return "·";
};
const colorFor = (status) => {
	if (status === "running" || status === "done") return "cyan";
	if (status === "warn") return "yellow";
	if (status === "failed") return "red";
	return "gray";
};
const StepsPanel = ({ steps }) => {
	if (steps.length === 0) return null;
	return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		paddingX: 1,
		children: [/* @__PURE__ */ jsx(Text, {
			dimColor: true,
			children: "Steps"
		}), steps.slice(-6).map((step, index) => /* @__PURE__ */ jsxs(Text, {
			color: colorFor(step.status),
			wrap: "truncate-end",
			children: [
				step.status === "running" ? /* @__PURE__ */ jsx(Spinner, { color: "cyan" }) : glyph(step.status),
				" ",
				step.label
			]
		}, `${index}-${step.label}`))]
	});
};
//#endregion
//#region src/ui/agent-tui/useStore.ts
const useStore = (store) => {
	const [, setTick] = useState(0);
	useEffect(() => {
		return store.subscribe(() => setTick((t) => t + 1));
	}, [store]);
	return store.getState();
};
//#endregion
//#region src/ui/agent-tui/AgentApp.tsx
const AgentApp = ({ store }) => {
	const state = useStore(store);
	useInput((_input, key) => {
		if (key.ctrl && _input === "c") {
			process.stdout.write("\x1B[?25h\x1B[?1049l");
			process.exit(130);
		}
	});
	const { stdout } = useStdout();
	const totalRows = stdout?.rows ?? 24;
	const activityRows = Math.max(3, Math.floor((totalRows - 10) / 2));
	return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		height: totalRows,
		children: [
			/* @__PURE__ */ jsxs(Box, {
				paddingX: 1,
				borderStyle: "single",
				borderColor: "gray",
				borderTop: false,
				borderLeft: false,
				borderRight: false,
				children: [/* @__PURE__ */ jsx(Text, {
					bold: true,
					color: "green",
					children: "aislop agent"
				}), /* @__PURE__ */ jsxs(Text, {
					dimColor: true,
					children: [" · ", state.provider]
				})]
			}),
			/* @__PURE__ */ jsxs(Box, {
				flexGrow: 1,
				children: [/* @__PURE__ */ jsxs(Box, {
					flexDirection: "column",
					flexGrow: 1,
					children: [
						/* @__PURE__ */ jsx(StepsPanel, { steps: state.steps }),
						/* @__PURE__ */ jsx(Box, {
							paddingX: 1,
							children: /* @__PURE__ */ jsx(Text, {
								dimColor: true,
								children: "Live output"
							})
						}),
						/* @__PURE__ */ jsx(ActivityPane, {
							activity: state.activity,
							rows: activityRows
						}),
						/* @__PURE__ */ jsx(FilesPanel, { files: state.files })
					]
				}), /* @__PURE__ */ jsx(Sidebar, { state })]
			}),
			state.pendingDecision ? /* @__PURE__ */ jsx(DecisionBar, { decision: state.pendingDecision }) : null,
			/* @__PURE__ */ jsx(FooterBar, {
				repo: state.targetRepo,
				branch: state.branch,
				worktree: state.worktree
			})
		]
	});
};
//#endregion
export { AgentApp };
