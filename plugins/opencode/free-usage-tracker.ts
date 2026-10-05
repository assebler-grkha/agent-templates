import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import * as os from "node:os";
import * as path from "node:path";

// Подсчет реально потраченных токенов из локальной БД OpenCode.
// Лимитов квот в БД нет (таблицы model_cost не существует, cost=0 на
// бесплатных тарифах), поэтому показываем факты расхода, а не проценты.
const MARKER = "⚡ Токены:";
// Префикс к следующему ходу (вариант для хостов без text.complete,
// например десктопа): цифры прошлого ответа. Опоздание на одно
// сообщение — приемлемо, это строка для понимания, не биллинг.
const PREFIX_MARKER = "⚡ Прошлый ответ:";

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
  // Kill-switch: FREE_USAGE_TRACKER=off отключает футер без удаления плагина.
  if (process.env.FREE_USAGE_TRACKER === "off") return null;
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

// API-fallback для хостов без sqlite-драйвера (десктоп на Node 20:
// require("node:sqlite") падает, bun:sqlite отсутствует). Читаем ту же
// информацию через client из PluginInput: session.messages дает токены
// и стоимость assistant-сообщений, session.list — агрегат "сегодня".
// Вызывается только если queryStats вернул null, сбои глушатся.
async function queryStatsAPI(
  client: any,
  sessionID: string,
  messageID: string,
): Promise<Row | null> {
  if (process.env.FREE_USAGE_TRACKER === "off") return null;
  try {
    if (!client || !client.session || typeof client.session.messages !== "function") return null;
    const messages = (await client.session.messages({ path: { id: sessionID } })) as Array<any>;
    if (!Array.isArray(messages)) return null;
    let sess = 0;
    let sessCost = 0;
    let model: string | null = null;
    for (const m of messages) {
      const info = m && typeof m === "object" && "info" in m ? m.info : m;
      if (!info || info.role !== "assistant") continue;
      if (messageID && info.id === messageID) continue;
      const t = info.tokens || {};
      sess += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
      sessCost += info.cost ?? 0;
      if (info.modelID) model = info.modelID;
    }
    // "Сегодня" — суммируем токены сессий, созданных после полуночи.
    let today: number | null = sess;
    try {
      if (typeof client.session.list === "function") {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const sessions = (await client.session.list()) as Array<any>;
        if (Array.isArray(sessions)) {
          let sum = 0;
          let any = false;
          for (const s of sessions) {
            const info = s && typeof s === "object" && "info" in s ? s.info : s;
            if (!info || (info.timeCreated ?? 0) < dayStart.getTime()) continue;
            sum +=
              (info.tokensInput ?? info.tokens_input ?? 0) +
              (info.tokensOutput ?? info.tokens_output ?? 0) +
              (info.tokensReasoning ?? info.tokens_reasoning ?? 0);
            any = true;
          }
          if (any) today = sum;
        }
      }
    } catch {
      // today останется равным sess
    }
    return { sess, today, model, sess_cost: sessCost };
  } catch {
    return null;
  }
}

async function getStats(
  client: any,
  sessionID: string,
  messageID: string,
): Promise<Row | null> {
  const local = queryStats(sessionID, messageID);
  if (local) return local;
  return queryStatsAPI(client, sessionID, messageID);
}

const fmt = (n: number | null): string =>
  (n ?? 0).toLocaleString("ru-RU");

export const FreeUsageTrackerPlugin: Plugin = async (input: any) => {
  // Дедуп: хук может срабатывать несколько раз на одно сообщение
  // (текст до/ после вызовов инструментов), футер клеим один раз.
  const footered = new Set<string>();
  // client из PluginInput — источник данных там, где нет sqlite-драйвера.
  const client = input ? (input as any).client : undefined;

  return {
    // Префикс-режим (метод DCP: мутация output.messages in place).
    // Показывает расход ПРОШЛОГО ответа при следующем ходе. Если для
    // прошлого ответа уже стоял пост-футер (footed через text.complete,
    // т.е. CLI) — молчим, чтобы не дублировать цифры.
    "experimental.chat.messages.transform": async (input: any, output: any) => {
      try {
        if (process.env.FREE_USAGE_TRACKER === "off") return;
        const messages = (output && output.messages ? output.messages : []) as Array<{
          info?: { id?: string; role?: string; sessionID?: string };
          parts?: Array<{ id?: string; type?: string; text?: string }>;
        }>;
        if (messages.length === 0) return;
        let ai = messages.length - 1;
        while (ai >= 0 && messages[ai].info?.role !== "assistant") ai -= 1;
        if (ai < 0) return;
        const lastAid = messages[ai].info?.id || "";
        if (lastAid && footered.has(lastAid)) return;
        let ui = messages.length - 1;
        while (ui >= 0 && messages[ui].info?.role !== "user") ui -= 1;
        if (ui < 0 || ui < ai) return;
        const um = messages[ui];
        const umID = um.info?.id || "";
        const sessionID =
          (input && input.sessionID ? String(input.sessionID) : "") || um.info?.sessionID || "";
        if (!sessionID) return;
        const parts = um.parts || (um.parts = []);
        const synthID = lastAid ? `prt_usage_${lastAid}` : "";
        if (synthID && parts.some((p) => p.id === synthID)) return;

        // Прошлый ответ уже в БД: messageID="" — ничего не исключаем.
        const stats = await getStats(client, sessionID, "");
        if (!stats) return;
        const lastText = (messages[ai].parts || [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n");
        const last = Math.max(1, Math.round(lastText.length / 4));
        const cost = stats.sess_cost ?? 0;
        const costPart = cost > 0 ? ` · $${cost.toFixed(4)}` : "";
        const modelPart = stats.model ? ` (${stats.model})` : "";
        const line =
          `${PREFIX_MARKER} ~${fmt(last)}` +
          ` · сессия ${fmt(stats.sess)}` +
          ` · сегодня ${fmt(stats.today)}${costPart}${modelPart}`;
        parts.push({
          id: synthID || "prt_usage_noid",
          sessionID,
          messageID: umID,
          type: "text",
          text: line,
        });
      } catch (e) {
        console.error("[free-usage-tracker] prefix failed:", e);
      }
    },
    // Реальный output-side хук SDK: мутация output.text по ссылке,
    // текст приклеивается детерминированно, в обход контекста ИИ.
    "experimental.text.complete": async (input, output) => {
      try {
        if (footered.has(input.messageID)) return;
        if (output.text.includes(MARKER)) return;
        const stats = await getStats(client, input.sessionID, input.messageID);
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

// v1 module form: `id` is shown in the OpenCode UI instead of the file path.
// The named export is kept so older hosts can still load the legacy path.
export default { id: "free-usage-tracker", server: FreeUsageTrackerPlugin } satisfies PluginModule;
