# Claude Code Project Instructions

## Search & Navigation Protocol
1. Use `codebase-memory-mcp` tools when available: `search_graph`, `trace_path`, `get_code_snippet`.
2. Check shared memory / architectural decisions before starting complex tasks.
3. Fall back to grep/glob only with targeted file patterns. Do not scan `node_modules`, `dist`, `.git`, or build dirs.

## Token Conservation & Tool Rules
- Never view full files larger than 100 lines. Use line range offsets.
- Never read `package-lock.json`, `pnpm-lock.yaml`, or log files.
- Keep bash command output concise: use `-q`, `--quiet`, piping through head/grep when inspecting output.

## Quality & Minimalism
- Adhere strictly to YAGNI: do not create speculative abstractions or unused wrappers.
- Verify changes with tests and run `npx aislop scan` before staging commits.
