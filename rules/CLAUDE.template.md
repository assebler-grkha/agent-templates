# Claude Code Project Instructions

## Search & Navigation Protocol
1. Use `codebase-memory-mcp` tools when available: first verify the exact project name (`codebase-memory-mcp_list_projects`) and index freshness (`codebase-memory-mcp_index_status`), then `codebase-memory-mcp_search_graph`, `codebase-memory-mcp_trace_path`, `codebase-memory-mcp_get_code_snippet`.
2. Check shared memory / architectural decisions before starting complex tasks.
3. Fall back to grep/glob only with targeted file patterns. Do not scan `node_modules`, `dist`, `.git`, or build dirs.

## Token Conservation & Tool Rules
- Never view full files larger than 100 lines. Use line range offsets.
- Never read `package-lock.json`, `pnpm-lock.yaml`, or log files.
- Keep bash command output concise: use `-q`, `--quiet`, piping through head/grep when inspecting output.

## Quality & Minimalism
- Adhere strictly to YAGNI: do not create speculative abstractions or unused wrappers.
- Verify changes with tests and run `aislop_aislop_scan` before staging commits (fallback: `node ~/.agent-templates/tools/aislop/dist/cli.js scan`). Order: scan first, then `aislop_aislop_fix`; on `MCP error -32001` retry on a smaller path or via CLI.
