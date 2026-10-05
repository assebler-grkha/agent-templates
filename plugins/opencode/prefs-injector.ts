import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import * as os from "node:os";
import * as path from "node:path";

// Авто-инжект предпочтений пользователя по типу задачи.
// Детерминированно, без LLM: keyword-score (multi-label union) по тексту
// сообщения + липкий контекст сессии + минимальный журнал в БД.
// Слоты (первый сработавший клеит, остальные видят маркер и молчат):
//   1. "experimental.chat.messages.transform" — основной (метод DCP:
//      мутация output.messages in place, append в последнюю text-часть
//      user-сообщения или push синтетической части);
//   2. "experimental.chat.system.transform" — только always-тезисы;
//   3. "chat.message" — fallback для хостов без transform-хуков.
// Сбои глушатся, ответ не ломается никогда.
const MARKER = "[User preferences (auto)]";
const ALWAYS_MARKER = "[prefs-always]";

// Бюджеты (символы): тезис / сценарий / весь инжект.
const THESIS_MAX = 140;
const SCENARIO_MAX = 400;
const INJECT_MAX = 1000;
// Липкость: сколько ходов помнить тег без новых совпадений.
const STICKY_TURNS = 10;
// Журнал: чистка записей старше 30 дней.
const JOURNAL_TTL_MS = 30 * 24 * 3600 * 1000;

// Словарь сценариев: тег -> ключевые слова (RU+EN). Расширяется без
// изменения кода: неизвестные теги из БД тоже работают, если их слова
// добавить сюда; совпадения идут только по словарю, не по тексту тезисов.
const KEYWORDS: Record<string, string[]> = {
  design: ["дизайн", "макет", "интерфейс", "ui", "ux", "верст", "css", "стиль", "шрифт", "цвет", "иконк", "эмодзи", "svg", "penpot", "figma", "лендинг", "страниц"],
  testing: ["тест", "test", "vitest", "jest", "pytest", "покрытие", "coverage", "моки", "mock", "стаб", "stub", "фикстур", "e2e", "юнит", "проверь работу", "регресс"],
  architecture: ["архитектур", "структур", "проект", "модул", "слой", "зависимост", "рефактор", "проектирова", "масштаб", "монолит", "микросервис", "схема бд", "api дизайн"],
  planning: ["план", "планиру", "roadmap", "задач", "todo", "этапы", "оценка", "приоритет", "scope", "тз", "специфик", "что делать"],
  security: ["безопасност", "security", "уязвимост", "аутентифик", "авторизац", "токен", "секрет", "парол", "xss", "sql-инъекц", "sql инъекц", "приватност", "шифрован"],
  docs: ["документ", "дока", "readme", "комментар", "changelog", "гайд", "инструкц", "опиши", "напиши доку"],
  debugging: ["баг", "ошибка", "падает", "debug", "отлад", "stacktrace", "лог", "не работает", "сломал", "почини", "фикс", "trace", "reproduce"],
  refactor: ["рефактор", "перепиши", "упрости", "вынеси", "переименуй", "чистый код", "дубли", "dead code", "почисти"],
  performance: ["производительност", "performance", "оптимиз", "тормоз", "медленно", "память", "профилир", "кэш", "скорость", "benchmark"],
  devops: ["деплой", "deploy", "ci", "docker", "git", "коммит", "релиз", "сборк", "build", "install", "установщик", "пайплайн", "хостинг", "сервер"],
};

type Pref = { tag: string; text: string };

function prefsDbPath(): string {
  const override = process.env.PREFS_DB_PATH;
  if (override) return override;
  return path.join(os.homedir(), ".opencode-mcp", "pathfinder-app", ".agentdb", "pathfinder.db");
}

function opencodeDbPath(): string {
  const override = process.env.OPENCODE_DB_PATH;
  if (override) return override;
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

function openDb(file: string, readOnly: boolean): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  } catch {
    // ignore, пробуем bun:sqlite
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as {
      Database: new (f: string, o?: { readonly?: boolean }) => any;
    };
    return new Database(file, readOnly ? { readonly: true } : {});
  } catch {
    return null;
  }
}

function loadPrefs(): Pref[] {
  const db = openDb(prefsDbPath(), true);
  if (!db) return [];
  try {
    const rows = db.prepare
      ? db.prepare("SELECT content, metadata FROM documents WHERE domain = 'preferences'").all()
      : db.query("SELECT content, metadata FROM documents WHERE domain = 'preferences'").all();
    const out: Pref[] = [];
    for (const r of rows as Array<{ content: string; metadata: string | null }>) {
      try {
        const meta = r.metadata ? (JSON.parse(r.metadata) as { tags?: string[] }) : {};
        const tags = Array.isArray(meta.tags) ? meta.tags : [];
        for (const tag of tags) {
          const text = (r.content || "").trim();
          if (tag && text) out.push({ tag, text });
        }
      } catch {
        // битая запись пропускается
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

type Journal = { active: string[]; turn: number; updatedAt: number };

function readJournal(sessionID: string): Journal | null {
  const db = openDb(prefsDbPath(), true);
  if (!db) return null;
  try {
    const row = (
      db.prepare
        ? db.prepare("SELECT content FROM documents WHERE id = ?").get(`prefs-log:${sessionID}`)
        : db.query("SELECT content FROM documents WHERE id = ?").get(`prefs-log:${sessionID}`)
    ) as { content: string } | null | undefined;
    if (!row) return null;
    return JSON.parse(row.content) as Journal;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function writeJournal(sessionID: string, j: Journal): void {
  const db = openDb(prefsDbPath(), false);
  if (!db) return;
  try {
    const content = JSON.stringify(j);
    if (db.prepare) {
      db.prepare(
        "INSERT INTO documents(id, domain, content, metadata) VALUES(?, 'prefs-sessions', ?, '{}') " +
          "ON CONFLICT(id) DO UPDATE SET content = excluded.content",
      ).run(`prefs-log:${sessionID}`, content);
    } else {
      db.query(
        "INSERT INTO documents(id, domain, content, metadata) VALUES(?1, 'prefs-sessions', ?2, '{}') " +
          "ON CONFLICT(id) DO UPDATE SET content = excluded.content",
      ).run(`prefs-log:${sessionID}`, content);
    }
    // Ленивая чистка журналов старше TTL (только при записи, редко).
    try {
      const sel = db.prepare
        ? db.prepare("SELECT id, content FROM documents WHERE domain = 'prefs-sessions'").all()
        : db.query("SELECT id, content FROM documents WHERE domain = 'prefs-sessions'").all();
      const now = Date.now();
      for (const r of sel as Array<{ id: string; content: string }>) {
        try {
          const j = JSON.parse(r.content) as Journal;
          if (now - (j.updatedAt || 0) > JOURNAL_TTL_MS && r.id !== `prefs-log:${sessionID}`) {
            if (db.prepare) db.prepare("DELETE FROM documents WHERE id = ?").run(r.id);
            else db.query("DELETE FROM documents WHERE id = ?1").run(r.id);
          }
        } catch {
          // битый журнал удаляем безжалостно
          try {
            if (db.prepare) db.prepare("DELETE FROM documents WHERE id = ?").run(r.id);
            else db.query("DELETE FROM documents WHERE id = ?1").run(r.id);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // чистка не удалась — не критично
    }
  } catch {
    // сбой записи журнала не должен ломать ответ
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

// Бэкфилл: последние K user-сообщений сессии из opencode.db (read-only).
function backfillText(sessionID: string, k = 20): string {
  const db = openDb(opencodeDbPath(), true);
  if (!db) return "";
  try {
    const sql =
      "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' " +
      "ORDER BY time_created DESC LIMIT ?";
    const rows = (
      db.prepare ? db.prepare(sql).all(sessionID, k) : db.query(sql).all(sessionID, k)
    ) as Array<{ data: string }>;
    const texts: string[] = [];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data) as { content?: Array<{ type?: string; text?: string }> };
        const t = (d.content || [])
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text as string)
          .join("\n");
        if (t) texts.push(t);
      } catch {
        // ignore
      }
    }
    return texts.join("\n");
  } catch {
    return "";
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function scoreTags(text: string): Map<string, number> {
  const lower = text.toLowerCase();
  const scores = new Map<string, number>();
  for (const [tag, words] of Object.entries(KEYWORDS)) {
    let s = 0;
    for (const w of words) {
      if (lower.includes(w)) s += 1;
    }
    if (s > 0) scores.set(tag, s);
  }
  return scores;
}

type SessionState = { turn: number; sticky: Map<string, number>; lastActive: string[] };

// Свободная форма сообщений для messages.transform (как у DCP:
// message = { info: { id, role, ... }, parts: [...] }).
type AnyPart = {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
};
type AnyMessage = {
  info?: { id?: string; role?: string; sessionID?: string };
  parts?: AnyPart[];
};

function messageText(m: AnyMessage): string {
  return (m.parts || [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function groupByTag(prefs: Pref[]): Map<string, string[]> {
  const byTag = new Map<string, string[]>();
  for (const p of prefs) {
    if (!byTag.has(p.tag)) byTag.set(p.tag, []);
    byTag.get(p.tag)?.push(p.text);
  }
  return byTag;
}

export const PrefsInjectorPlugin: Plugin = async () => {
  const memory = new Map<string, SessionState>();

  // Восстановление состояния: память -> журнал решений -> история.
  function getState(sessionID: string, historyText: string): SessionState | null {
    if (!sessionID) return null;
    let st = memory.get(sessionID);
    if (!st) {
      st = { turn: 0, sticky: new Map(), lastActive: [] };
      const j = readJournal(sessionID);
      if (j && Array.isArray(j.active) && j.active.length > 0) {
        st.turn = j.turn || 0;
        for (const t of j.active) st.sticky.set(t, st.turn);
      } else if (historyText) {
        for (const t of scoreTags(historyText).keys()) st.sticky.set(t, 0);
      }
      memory.set(sessionID, st);
    }
    return st;
  }

  function decay(st: SessionState): void {
    for (const [t, seen] of [...st.sticky]) {
      if (st.turn - seen > STICKY_TURNS) st.sticky.delete(t);
    }
  }

  // Активный набор: union совпадений и липких; always — только если
  // includeAlways (chat.message-fallback; в transform-режиме always
  // владеет system.transform); default — когда больше ничего нет.
  function pickActive(
    byTag: Map<string, string[]>,
    matched: Map<string, number>,
    st: SessionState | null,
    includeAlways: boolean,
  ): Set<string> {
    const active = new Set<string>([...matched.keys(), ...(st ? [...st.sticky.keys()] : [])]);
    if (includeAlways && byTag.has("always")) active.add("always");
    if (active.size === 0 || (includeAlways && active.size === 1 && active.has("always"))) {
      if (byTag.has("default")) active.add("default");
    }
    return active;
  }

  // Сборка инжекта с бюджетами: always первые, затем свежие.
  function renderLines(
    active: Set<string>,
    byTag: Map<string, string[]>,
    st: SessionState | null,
  ): string[] {
    const order = [...active].sort((a, b) => {
      if (a === "always") return -1;
      if (b === "always") return 1;
      return (st?.sticky.get(b) ?? -1) - (st?.sticky.get(a) ?? -1);
    });
    const lines: string[] = [];
    let total = 0;
    let dropped = 0;
    for (const tag of order) {
      const theses = (byTag.get(tag) || []).filter((t) => t.length <= THESIS_MAX);
      dropped += (byTag.get(tag) || []).length - theses.length;
      let joined = theses.join(" ");
      if (joined.length > SCENARIO_MAX) {
        joined = joined.slice(0, SCENARIO_MAX - 1).trimEnd() + "…";
      }
      if (!joined) continue;
      const line = `- [${tag}] ${joined}`;
      if (total + line.length > INJECT_MAX) {
        dropped += 1;
        continue;
      }
      total += line.length;
      lines.push(line);
    }
    if (lines.length === 0) return lines;
    if (dropped > 0) lines.push(`…(+${dropped} скрыто бюджетом)`);
    return lines;
  }

  // Журнал: пишем только при изменении активного набора.
  function touchJournal(sessionID: string, st: SessionState, active: Set<string>): void {
    const snapshot = [...active].sort();
    if (JSON.stringify(snapshot) !== JSON.stringify(st.lastActive)) {
      st.lastActive = snapshot;
      writeJournal(sessionID, { active: snapshot, turn: st.turn, updatedAt: Date.now() });
    }
  }

  return {
    // Основной слот (метод DCP): мутация output.messages in place.
    // Срабатывает каждый ход; историю для липкости берем прямо из
    // messages, журнал — только при пустой памяти.
    "experimental.chat.messages.transform": async (input: any, output: any) => {
      try {
        if (process.env.USER_PREFS === "off") return;
        const messages = (output && output.messages ? output.messages : []) as AnyMessage[];
        if (messages.length === 0) return;
        let idx = messages.length - 1;
        while (idx >= 0 && messages[idx].info?.role !== "user") idx -= 1;
        if (idx < 0) return;
        const um = messages[idx];
        const current = messageText(um);
        if (!current || current.includes(MARKER)) return;
        const messageID = um.info?.id || "";
        const sessionID =
          (input && input.sessionID ? String(input.sessionID) : "") || um.info?.sessionID || "";
        const history = messages
          .slice(Math.max(0, idx - 10), idx)
          .filter((m) => m.info?.role === "user")
          .map(messageText)
          .join("\n");

        const prefs = loadPrefs();
        if (prefs.length === 0) return;
        const byTag = groupByTag(prefs);

        const matched = scoreTags(current);
        const st = getState(sessionID, history);
        if (st) {
          st.turn += 1;
          for (const t of matched.keys()) st.sticky.set(t, st.turn);
          decay(st);
        } else {
          // Без sessionID — одноразовый подбор: текущее + история,
          // без памяти и журнала (нечего привязать).
          for (const [t, s] of scoreTags(history)) {
            matched.set(t, (matched.get(t) ?? 0) + s);
          }
        }

        const active = pickActive(byTag, matched, st, false);
        const lines = renderLines(active, byTag, st);
        if (lines.length === 0) return;
        const block = `\n\n${MARKER}\n${lines.join("\n")}`;

        const parts = um.parts || (um.parts = []);
        const target = parts.filter((p) => p.type === "text" && typeof p.text === "string").pop();
        if (target && target.text) {
          target.text += block;
        } else {
          // Синтетическая часть по рецепту DCP: стабильный id.
          parts.push({
            id: messageID ? `prt_prefs_${messageID}` : "prt_prefs_noid",
            sessionID,
            messageID,
            type: "text",
            text: block.trimStart(),
          });
        }
        if (st && sessionID) touchJournal(sessionID, st, active);
      } catch (e) {
        console.error("[prefs-injector] messages.transform failed:", e);
      }
    },

    // Always-тезисы — в system prompt (слот DCP). messages.transform
    // их намеренно не дублирует (pickActive с includeAlways=false).
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      try {
        if (process.env.USER_PREFS === "off") return;
        const sys = output && output.system ? output.system : null;
        if (!Array.isArray(sys)) return;
        if (sys.join("\n").includes(ALWAYS_MARKER)) return;
        const theses = loadPrefs()
          .filter((p) => p.tag === "always" && p.text.length <= THESIS_MAX)
          .map((p) => p.text);
        if (theses.length === 0) return;
        let block = theses.join(" ");
        if (block.length > SCENARIO_MAX) {
          block = block.slice(0, SCENARIO_MAX - 1).trimEnd() + "…";
        }
        const line = `${ALWAYS_MARKER}\n${block}`;
        if (sys.length === 0) sys.push(line);
        else sys[sys.length - 1] += `\n\n${line}`;
      } catch (e) {
        console.error("[prefs-injector] system.transform failed:", e);
      }
    },

    // Fallback для хостов без transform-хуков (проверен в CLI):
    // дописываем полный набор (включая always) в parts.
    "chat.message": async (input, output) => {
      try {
        if (process.env.USER_PREFS === "off") return;
        const parts = output.parts as Array<{ type?: string; text?: string }>;
        const target = parts.find((p) => p.type === "text" && typeof p.text === "string");
        if (!target || !target.text) return;
        const incoming = parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text as string)
          .join("\n");
        if (target.text.includes(MARKER)) return;

        const st = getState(input.sessionID, backfillText(input.sessionID));
        if (st) {
          st.turn += 1;
          for (const t of scoreTags(incoming).keys()) st.sticky.set(t, st.turn);
          decay(st);
        }
        const matched = scoreTags(incoming);

        const prefs = loadPrefs();
        if (prefs.length === 0) return;
        const byTag = groupByTag(prefs);
        const active = pickActive(byTag, matched, st, true);
        const lines = renderLines(active, byTag, st);
        if (lines.length === 0) return;

        target.text += `\n\n${MARKER}\n${lines.join("\n")}`;
        if (st) touchJournal(input.sessionID, st, active);
      } catch (e) {
        console.error("[prefs-injector] inject failed:", e);
      }
    },
  };
};

const PrefsInjectorModule = {
  id: "prefs-injector",
  server: PrefsInjectorPlugin,
} satisfies PluginModule;

export default PrefsInjectorModule;
