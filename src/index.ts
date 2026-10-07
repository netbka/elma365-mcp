#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getAppItemsSchema, handleGetAppItems, createItemSchema, handleCreateItem } from "./tools/app-items.js";
import { getTasksSchema, handleGetTasks } from "./tools/tasks.js";
import { getProcessesSchema, handleGetProcesses, startProcessSchema, handleStartProcess } from "./tools/processes.js";
import { getUsersSchema, handleGetUsers, getUserByIdSchema, handleGetUserById } from "./tools/users.js";
import { getCommentsSchema, handleGetComments, addCommentSchema, handleAddComment } from "./tools/comments.js";
import {
  getWidgetSchema,
  handleGetWidget,
  getWidgetHistorySchema,
  handleGetWidgetHistory,
  getWidgetVersionSchema,
  handleGetWidgetVersion,
  setWidgetScriptSchema,
  handleSetWidgetScript,
} from "./tools/designer.js";
import { startHttpTransport } from "./transport/http.js";

const TOOL_COUNT = 13;

export function createServer(): McpServer {
  const server = new McpServer({
    name: "elma365-mcp",
    version: "1.1.0",
  });

  // --- App Items ---
  server.tool(
    "get_app_items",
    "Получить список элементов приложения ELMA365 по namespace и code.",
    getAppItemsSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetAppItems(params) }] }),
  );

  server.tool(
    "create_item",
    "Создать новый элемент в приложении ELMA365.",
    createItemSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleCreateItem(params) }] }),
  );

  // --- Tasks ---
  server.tool(
    "get_tasks",
    "Получить список BPM-задач ELMA365.",
    getTasksSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetTasks(params) }] }),
  );

  // --- Processes ---
  server.tool(
    "get_processes",
    "Получить список бизнес-процессов ELMA365.",
    getProcessesSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetProcesses(params) }] }),
  );

  server.tool(
    "start_process",
    "Запустить бизнес-процесс ELMA365 по коду.",
    startProcessSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleStartProcess(params) }] }),
  );

  // --- Users ---
  server.tool(
    "get_users",
    "Получить список пользователей ELMA365.",
    getUsersSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetUsers(params) }] }),
  );

  server.tool(
    "get_user_by_id",
    "Получить пользователя ELMA365 по ID.",
    getUserByIdSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetUserById(params) }] }),
  );

  // --- Comments ---
  server.tool(
    "get_comments",
    "Получить комментарии к элементу приложения ELMA365.",
    getCommentsSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetComments(params) }] }),
  );

  server.tool(
    "add_comment",
    "Добавить комментарий к элементу приложения ELMA365.",
    addCommentSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleAddComment(params) }] }),
  );

  // --- Designer (widget script push, via headless browser) ---
  server.tool(
    "get_widget",
    "Прочитать текущее состояние виджета/формы в App Designer: version, draft, clientScripts/serverScripts. Требует ELMA365_DESIGNER_EMAIL/PASSWORD (отдельная авторизация от Bearer-токена, через реальную сессию Дизайнера).",
    getWidgetSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetWidget(params) }] }),
  );

  server.tool(
    "get_widget_history",
    "Получить страницу истории публикаций виджета/формы (версии, время, автор, комментарий). offset задаёт смещение строк; полная страница не доказывает полноту истории.",
    getWidgetHistorySchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetWidgetHistory(params) }] }),
  );

  server.tool(
    "get_widget_version",
    "Read a native historical widget/form revision, including descriptor, runtime and native author metadata. revisionId is a history row __id. Checks revision/widget identity; never applies or publishes the revision. Requires Designer session credentials.",
    getWidgetVersionSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleGetWidgetVersion(params) }] }),
  );

  server.tool(
    "set_widget_script",
    "Применить локальную правку скрипта (например, из descriptor.clientScripts экспорта elma365pm) к виджету/форме через App Designer: вставка, Сохранить, Проверить и (по умолчанию) Опубликовать. Единственный подтверждённо рабочий способ применить правку скрипта сегодня — elma365pm import/check не работает для EXTENSION-модулей с человекочитаемым кодом, а прямой PUT /api/widgets/{id} требует живой сессионный JWT и lock-hash, которые этот инструмент намеренно не извлекает для повторного использования вне Дизайнера.",
    setWidgetScriptSchema.shape,
    async (params) => ({ content: [{ type: "text", text: await handleSetWidgetScript(params) }] }),
  );

  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const httpFlag = args.includes("--http");
  const portIndex = args.indexOf("--port");
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3000;

  const server = createServer();

  if (httpFlag) {
    await startHttpTransport(server, port);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `[elma365-mcp] Сервер запущен (stdio). ${TOOL_COUNT} инструментов. `
      + "Требуется ELMA365_DOMAIN + ELMA365_TOKEN. "
      + "Инструменты get_widget/get_widget_history/get_widget_version/set_widget_script дополнительно требуют ELMA365_DESIGNER_EMAIL + ELMA365_DESIGNER_PASSWORD.",
    );
  }
}

main().catch((error) => {
  console.error("[elma365-mcp] Ошибка:", error);
  process.exit(1);
});
