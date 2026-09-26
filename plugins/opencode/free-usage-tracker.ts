import type { Plugin } from "@opencode-ai/plugin";
import * as os from "node:os";
import * as path from "node:path";

// Подсчет реально потраченных токенов из локальной БД OpenCode.
// Лимитов квот в БД нет (таблицы model_cost не существует, cost=0 на
// бесплатных тарифах), поэтому показываем факты расхода, а не проценты.
const MARKER = "⚡ Токены:";

function dbPath(): string {
  const override = process.env.OPENCODE_DB_PATH;
  if (override) return override;
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

type Row = {
  sess: number | null;
  today: number | null;
  model: string | null;
  sess_cost: number | null;
};

// Читаем через node:sqlite (Node 22.5+) или bun:sqlite (рантайм OpenCode).
// Ни одной зависимости не тянем; если драйверов нет, тихо без футера.
function queryStats(sessionID: string, messageID: string): Row | null {
  const file = dbPath();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const sql = `
    SELECT
      (SELECT SUM(
         COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0) +
         COALESCE(CAST(json_extract(data, '$.tokens.output') AS INTEGER), 0) +
         COALESCE(CAST(json_extract(data, '$.tokens.reasoning') AS INTEGER), 0))
       FROM message
       WHERE session_id = ? AND id != ?
         AND json_extract(data, '$.role') = 'assistant') AS sess,
      (SELECT SUM(
         COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0) +
         COALESCE(CAST(json_extract(data, '$.tokens.output') AS INTEGER), 0) +
         COALESCE(CAST(json_extract(data, '$.tokens.reasoning') AS INTEGER), 0))
       FROM message
       WHERE time_created >= ?
         AND json_extract(data, '$.role') = 'assistant') AS today,
      (SELECT json_extract(data, '$.modelID') FROM message
       WHERE json_extract(data, '$.role') = 'assistant'
       ORDER BY time_created DESC LIMIT 1) AS model,
      (SELECT SUM(COALESCE(CAST(json_extract(data, '$.cost') AS REAL), 0))
       FROM message
       WHERE session_id = ? AND id != ?) AS sess_cost`;
  const args = [sessionID, messageID, dayStart.getTime(), sessionID, messageID];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).get(...args) as Row;
    } finally {
      db.close();
    }
  } catch {
    // ignore, пробуем bun:sqlite
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as {
      Database: new (f: string, o?: { readonly?: boolean }) => {
        query: (s: string) => { get: (...a: unknown[]) => Row };
        close: () => void;
      };
    };
    const db = new Database(file, { readonly: true });
    try {
      return db.query(sql).get(...args);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const fmt = (n: number | null): string =>
  (n ?? 0).toLocaleString("ru-RU");

export const FreeUsageTrackerPlugin: Plugin = async () => {
  // Дедуп: хук может срабатывать несколько раз на одно сообщение
  // (текст до/ после вызовов инструментов), футер клеим один раз.
  const footered = new Set<string>();

  return {
    // Реальный output-side хук SDK: мутация output.text по ссылке,
    // текст приклеивается детерминированно, в обход контекста ИИ.
    "experimental.text.complete": async (input, output) => {
      try {
        if (footered.has(input.messageID)) return;
        if (output.text.includes(MARKER)) return;
        const stats = queryStats(input.sessionID, input.messageID);
        if (!stats) return;

        // Оценка текущего ответа: ~4 символа на токен.
        const current = Math.max(1, Math.round(output.text.length / 4));
        const sess = (stats.sess ?? 0) + current;
        const today = (stats.today ?? 0) + current;
        const cost = stats.sess_cost ?? 0;
        const costPart = cost > 0 ? ` · $${cost.toFixed(4)}` : "";
        const modelPart = stats.model ? ` (${stats.model})` : "";

        output.text +=
          `

---
${MARKER} ответ ~${fmt(current)}` +
          ` · сессия ${fmt(sess)}` +
          ` · сегодня ${fmt(today)}${costPart}${modelPart}`;
        footered.add(input.messageID);
      } catch (e) {
        console.error("[free-usage-tracker] append failed:", e);
      }
    },
  };
};

export default FreeUsageTrackerPlugin;
