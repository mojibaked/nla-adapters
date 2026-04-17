import { randomUUID } from "node:crypto";
import {
  defineToolLoopSessionAdapter,
  tool,
  type NlaAdapterDefinition,
  type NlaToolLoopModel,
  type NlaToolLoopSessionMemoryStore
} from "@nla/sdk-core";
import type { StorageClient } from "@nla-adapters/contracts";

export const DefaultTodoStorageKey = "todo.items";

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: "open" | "completed";
  readonly createdAt: string;
  readonly completedAt?: string;
}

interface TodoResultOutput {
  readonly kind: "todo.result";
  readonly operation: "add" | "list" | "complete";
  readonly status: "created" | "ok" | "completed" | "not_found";
  readonly todo?: TodoItem;
  readonly todos?: ReadonlyArray<TodoItem>;
  readonly queryText?: string;
}

export interface TodoAgentDependencies {
  readonly createModel: () => NlaToolLoopModel;
  readonly storage: Pick<StorageClient, "getJson" | "putJson">;
  readonly storageKey?: string;
  readonly conversationMemory?: NlaToolLoopSessionMemoryStore<{}>;
}

export const createTodoAgent = (
  dependencies: TodoAgentDependencies
): NlaAdapterDefinition => {
  const storageKey = dependencies.storageKey?.trim() || DefaultTodoStorageKey;

  return defineToolLoopSessionAdapter<{}>({
    id: "todo.agent",
    name: "Todo Agent",
    description: "Portable todo list adapter backed by injected storage and model contracts.",
    instructions: [
      "You manage the user's todo list.",
      "Use the available tools to add, list, or complete todos.",
      "Do not invent todo state without consulting the tools.",
      "Keep responses concise and grounded in tool output."
    ].join(" "),
    model: () => dependencies.createModel(),
    maxIterations: 6,
    memory: dependencies.conversationMemory,
    tools: [
      tool<{}, unknown, TodoResultOutput>({
        name: "add_todo",
        description: "Add a new todo item for the user.",
        inputSchema: todoTextInputSchema("Todo text to add"),
        execute: async (_context, input) => {
          const text = requireTodoText(input, "add_todo requires a non-empty text field");
          const items = await readTodos(dependencies.storage, storageKey);
          const nextItem: TodoItem = {
            id: randomUUID(),
            text,
            status: "open",
            createdAt: new Date().toISOString()
          };

          await writeTodos(dependencies.storage, storageKey, [...items, nextItem]);
          return {
            kind: "todo.result",
            operation: "add",
            status: "created",
            todo: nextItem
          };
        }
      }),
      tool<{}, unknown, TodoResultOutput>({
        name: "list_todos",
        description: "List the current todo items, including which ones are completed.",
        inputSchema: emptyObjectSchema(),
        execute: async () =>
          ({
            kind: "todo.result",
            operation: "list",
            status: "ok",
            todos: await readTodos(dependencies.storage, storageKey)
          })
      }),
      tool<{}, unknown, TodoResultOutput>({
        name: "complete_todo",
        description: "Mark an existing todo item as completed.",
        inputSchema: todoTextInputSchema("Todo text to complete"),
        execute: async (_context, input) => {
          const text = requireTodoText(input, "complete_todo requires a non-empty text field");
          const items = await readTodos(dependencies.storage, storageKey);
          const matchIndex = findTodoIndex(items, text);

          if (matchIndex < 0) {
            return {
              kind: "todo.result",
              operation: "complete",
              status: "not_found",
              queryText: text
            };
          }

          const item = items[matchIndex];
          const updated: TodoItem = {
            ...item,
            status: "completed",
            completedAt: new Date().toISOString()
          };
          const nextItems = items.map((entry, index) =>
            index === matchIndex ? updated : entry
          );

          await writeTodos(dependencies.storage, storageKey, nextItems);
          return {
            kind: "todo.result",
            operation: "complete",
            status: "completed",
            todo: updated
          };
        }
      })
    ]
  });
};

function todoTextInputSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: {
        type: "string",
        description
      }
    }
  };
}

function emptyObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {}
  };
}

const readTodos = async (
  storage: Pick<StorageClient, "getJson">,
  storageKey: string
): Promise<ReadonlyArray<TodoItem>> =>
  decodeTodos(
    await storage.getJson({
      scope: "install",
      key: storageKey
    })
  );

const writeTodos = async (
  storage: Pick<StorageClient, "putJson">,
  storageKey: string,
  items: ReadonlyArray<TodoItem>
): Promise<void> => {
  await storage.putJson({
    scope: "install",
    key: storageKey,
    value: items
  });
};

const decodeTodos = (value: unknown): ReadonlyArray<TodoItem> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => isTodoItem(entry) ? [entry] : []);
};

const isTodoItem = (value: unknown): value is TodoItem => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.text === "string" &&
    (record.status === "open" || record.status === "completed") &&
    typeof record.createdAt === "string" &&
    (record.completedAt === undefined || typeof record.completedAt === "string")
  );
};

const requireTodoText = (
  input: unknown,
  message: string
): string => {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const text = typeof record?.text === "string" ? record.text.trim() : "";

  if (!text) {
    throw new Error(message);
  }

  return text;
};

const findTodoIndex = (
  items: ReadonlyArray<TodoItem>,
  query: string
): number => {
  const normalizedQuery = normalize(query);
  const openItems = items
    .map((item, index) => ({
      index,
      item
    }))
    .filter((entry) => entry.item.status === "open");

  const exact = openItems.find((entry) => normalize(entry.item.text) === normalizedQuery);
  if (exact) {
    return exact.index;
  }

  const partial = openItems.find((entry) => normalize(entry.item.text).includes(normalizedQuery));
  return partial?.index ?? -1;
};

const normalize = (value: string): string =>
  value.trim().toLowerCase();
