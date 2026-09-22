#!/usr/bin/env node
//#region src/ui/agent-tui/mount.ts
const mountAgentTui = async (store) => {
	const [{ render }, React, { AgentApp }] = await Promise.all([
		import("ink"),
		import("react"),
		import("./AgentApp-I2SNmdel.js")
	]);
	process.stdout.write("\x1B[?1049h\x1B[?25l");
	const instance = render(React.createElement(AgentApp, { store }), { exitOnCtrlC: false });
	return { close: async () => {
		instance.unmount();
		await instance.waitUntilExit();
		process.stdout.write("\x1B[?25h\x1B[?1049l");
	} };
};
//#endregion
export { mountAgentTui };
