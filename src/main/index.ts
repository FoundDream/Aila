import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type { ProviderId } from "@shared/models";
import * as dotenv from "dotenv";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  getModelInfo,
  type ModelSelection,
  streamChat,
} from "./agent";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listDocConversations,
  type PersistedImageBlock,
  type PersistedMessage,
  renameConversation,
  setConversationUsage,
} from "./conversations";
import { buildAgentContext } from "./context";
import type { DocRecord } from "./docs";
import type { DocPatch } from "./docs";
import {
  createDoc,
  createFolder,
  deleteDoc,
  deleteFolder,
  getDoc,
  listAll,
  moveFolder,
  renameFolder,
  updateDoc,
} from "./docs";
import {
  applyFindReplace,
  type FindReplaceEdit,
  formatFindReplaceErrors,
} from "./find-replace";
import {
  handleImageProtocol,
  imageNameFromUrl,
  registerImageProtocolScheme,
  saveImage,
} from "./images";
import { getOpenRouterCatalog } from "./openrouter-catalog";
import { getDataDir, getImagesDir } from "./paths";
import {
  configuredProviders,
  loadSettings,
  type Settings,
  saveSettings,
} from "./settings";
import type { DocEditRequest, DocEditResult } from "./tools";

dotenv.config();

// Custom schemes must be registered before the app `ready` event fires.
registerImageProtocolScheme();

// electron-vite injects the renderer dev server's *actual* URL here. Don't
// hardcode the port: if another Vite app already holds 5173, our renderer
// falls back to 5174 and a hardcoded 5173 would load the wrong app (or fail).
const DEV_RENDERER_URL =
  process.env["ELECTRON_RENDERER_URL"] ?? "http://localhost:5173";

let mainWindow: BrowserWindow | null = null;

interface StreamSlot {
  controller: AbortController;
  cleanup: Promise<void>;
}

// One slot per conversation. The cleanup promise resolves only after the
// stream's persistence side-effects have written to disk — chat:send awaits
// it so a fresh user message can never land on disk before the previous
// (possibly aborted) assistant message.
const activeStreams = new Map<string, StreamSlot>();

// edit_doc tool round-trip: tool fires, main webContents.send's a request to
// the renderer (which dispatches a CodeMirror transaction for the active
// doc), renderer ipcRenderer.send's the response, main resolves the matching
// promise. 5s timeout to avoid wedging the model on a missing/crashed view.
const DOC_EDIT_TIMEOUT_MS = 5000;

interface PendingDocEdit {
  resolve: (result: DocEditResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingDocEdits = new Map<string, PendingDocEdit>();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f4f7fb",
    trafficLightPosition: { x: 6, y: 10 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  if (is.dev) {
    mainWindow.loadURL(DEV_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function send(channel: string, data?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

async function persistAndAnnounce(
  conversationId: string,
  message: PersistedMessage,
): Promise<void> {
  const summary = await appendMessage(conversationId, message);
  send("conversations:updated", summary);
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    "chat:send",
    async (
      _event,
      conversationId: string,
      userText: string,
      selection: ModelSelection,
    ) => {
      // Wait for any prior stream on this conversation to fully clean up
      // (including its persisted error/done message) before we touch the log.
      // The renderer's queue runner already serializes per-conversation, but
      // an abort+immediate-resend flow would otherwise race.
      const previous = activeStreams.get(conversationId);
      if (previous) await previous.cleanup.catch(() => {});

      const userMessage: PersistedMessage = {
        id: randomUUID(),
        role: "user",
        blocks: [{ type: "text", content: userText }],
        status: "done",
      };
      await persistAndAnnounce(conversationId, userMessage);

      const assistantMessageId = randomUUID();
      const controller = new AbortController();
      let resolveCleanup: () => void = () => {};
      const cleanup = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      activeStreams.set(conversationId, { controller, cleanup });

      const record = await getConversation(conversationId);
      let boundDoc: DocRecord | null = null;

      // Doc-bound conversation: read the current doc body and prepend it as a
      // budgeted system message every time. Re-reading on each send keeps the
      // context fresh — the user might be editing while chatting in the sidebar.
      const boundDocPath = record.meta.docId ?? null;
      const profileId = boundDocPath ? "doc" : "chat";
      if (boundDocPath) {
        try {
          boundDoc = await getDoc(boundDocPath);
        } catch (err) {
          console.warn(
            "[chat:send] doc context fetch failed for",
            boundDocPath,
            err,
          );
        }
      }
      const context = buildAgentContext({
        messages: record.messages,
        doc: boundDoc,
        latestUserText: userText,
        modelInfo: getModelInfo(selection.providerId, selection.modelId),
      });
      const messages = context.messages;

      // Wire the doc-edit side-channel only for doc-bound conversations. Plain
      // chat-tab conversations don't get edit_doc capability — there's no
      // "current document" to operate on, and we don't want the model going
      // off and editing arbitrary docs from the chat tab.
      const onDocEdit = boundDocPath
        ? (req: DocEditRequest): Promise<DocEditResult> =>
            new Promise<DocEditResult>((resolve) => {
              const requestId = randomUUID();
              const timer = setTimeout(() => {
                if (pendingDocEdits.delete(requestId)) {
                  resolve({
                    ok: false,
                    error: "editor did not respond within 5s",
                  });
                }
              }, DOC_EDIT_TIMEOUT_MS);
              pendingDocEdits.set(requestId, { resolve, timer });
              send("docs:edit-request", {
                requestId,
                docPath: req.docPath,
                edits: req.edits,
                reason: req.reason,
              });
            })
        : undefined;

      void (async () => {
        try {
          await streamChat(
            {
              conversationId,
              assistantMessageId,
              messages,
              selection,
              signal: controller.signal,
              profileId,
              onDocEdit,
              boundDocPath: boundDocPath ?? undefined,
            },
            {
              onTextDelta: (event) => send("chat:text-delta", event),
              onReasoningDelta: (event) => send("chat:reasoning-delta", event),
              onToolCallStart: (event) => send("chat:tool-call-start", event),
              onToolCallArgsDelta: (event) =>
                send("chat:tool-call-args-delta", event),
              onToolCallResult: (event) => send("chat:tool-call-result", event),
              onImageBlock: (event) => send("chat:image-block", event),
              onDone: async (event) => {
                await persistAndAnnounce(conversationId, event.message);
                if (event.usage) {
                  const summary = await setConversationUsage(
                    conversationId,
                    event.usage,
                  );
                  send("conversations:updated", summary);
                }
                send("chat:done", event);
              },
              onError: async (event) => {
                await persistAndAnnounce(conversationId, event.message);
                send("chat:error", event);
              },
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[chat] unexpected stream error:", message);
          const errored: PersistedMessage = {
            id: assistantMessageId,
            role: "assistant",
            blocks: [],
            status: "error",
            error: message,
            model: selection,
          };
          await persistAndAnnounce(conversationId, errored).catch(() => {});
          send("chat:error", {
            conversationId,
            messageId: assistantMessageId,
            error: message,
            message: errored,
          });
        } finally {
          if (activeStreams.get(conversationId)?.controller === controller) {
            activeStreams.delete(conversationId);
          }
          resolveCleanup();
        }
      })();

      return { userMessage, assistantMessageId };
    },
  );

  // Don't remove from the map here — the stream's finally{} block handles
  // that after persisting the partial message. Keeping the slot ensures any
  // subsequent chat:send awaits the cleanup before writing.
  ipcMain.handle("chat:abort", (_event, conversationId: string) => {
    activeStreams.get(conversationId)?.controller.abort();
  });

  ipcMain.handle("docs:list", () => listAll());
  ipcMain.handle("docs:get", (_event, docPath: string) => getDoc(docPath));
  ipcMain.handle("docs:create", (_event, folderPath?: string | null) =>
    createDoc(folderPath ?? null),
  );
  ipcMain.handle("docs:update", (_event, docPath: string, patch: DocPatch) =>
    updateDoc(docPath, patch),
  );

  ipcMain.handle(
    "folders:create",
    (_event, parentPath: string | null, name: string) =>
      createFolder(parentPath, name),
  );
  ipcMain.handle("folders:rename", (_event, path: string, newName: string) =>
    renameFolder(path, newName),
  );
  ipcMain.handle(
    "folders:move",
    (_event, path: string, newParentPath: string | null) =>
      moveFolder(path, newParentPath),
  );
  // Renderer's reply to docs:edit-request fired during edit_doc tool execution.
  // Resolves the pending promise so the tool can return a result string to the
  // model. ipcMain.on (not handle) because the renderer uses ipcRenderer.send.
  ipcMain.on(
    "docs:edit-response",
    (_event, payload: { requestId: string } & DocEditResult) => {
      const pending = pendingDocEdits.get(payload.requestId);
      if (!pending) return;
      pendingDocEdits.delete(payload.requestId);
      clearTimeout(pending.timer);
      const { requestId: _id, ...result } = payload;
      pending.resolve(result);
    },
  );

  // Direct disk-based find/replace for docs that aren't currently mounted in
  // the editor. Used by the renderer when edit_doc targets an inactive doc.
  ipcMain.handle(
    "docs:apply-edit-direct",
    async (
      _event,
      input: { docPath: string; edits: FindReplaceEdit[] },
    ): Promise<DocEditResult> => {
      let doc: Awaited<ReturnType<typeof getDoc>>;
      try {
        doc = await getDoc(input.docPath);
      } catch {
        return { ok: false, error: `doc not found: ${input.docPath}` };
      }
      const result = applyFindReplace(doc.content, input.edits);
      if (!result.ok) {
        return { ok: false, error: formatFindReplaceErrors(result.errors) };
      }
      await updateDoc(input.docPath, { content: result.body });
      return { ok: true, title: doc.title, appliedCount: result.appliedCount };
    },
  );

  async function sweepOrphanedDocConversations(): Promise<void> {
    const [{ docs }, convos] = await Promise.all([
      listAll(),
      listConversations(),
    ]);
    const liveDocPaths = new Set(docs.map((d) => d.path));
    const orphans = convos.filter((c) => c.docId && !liveDocPaths.has(c.docId));
    await Promise.all(
      orphans.map(async (orphan) => {
        const slot = activeStreams.get(orphan.id);
        if (slot) {
          slot.controller.abort();
          await slot.cleanup.catch(() => {});
        }
        await deleteConversation(orphan.id);
      }),
    );
  }

  ipcMain.handle("docs:delete", async (_event, docPath: string) => {
    await deleteDoc(docPath);
    await sweepOrphanedDocConversations();
  });

  ipcMain.handle("folders:delete", async (_event, path: string) => {
    await deleteFolder(path);
    await sweepOrphanedDocConversations();
  });

  ipcMain.handle(
    "images:save",
    (_event, bytes: ArrayBuffer, filename: string) =>
      saveImage(bytes, filename),
  );

  ipcMain.handle(
    "chat:get-model-info",
    (_event, providerId: ProviderId, modelId: string) =>
      getModelInfo(providerId, modelId),
  );

  function packSettings(settings: Settings): {
    settings: Settings;
    configuredProviders: ProviderId[];
  } {
    return { settings, configuredProviders: configuredProviders(settings) };
  }
  ipcMain.handle("settings:get", () => packSettings(loadSettings()));
  ipcMain.handle("settings:set", (_event, next: Settings) =>
    packSettings(saveSettings(next)),
  );
  ipcMain.handle("openrouter:list-models", () => getOpenRouterCatalog());

  ipcMain.handle("conversations:list", () => listConversations());
  ipcMain.handle("conversations:get", (_event, id: string) =>
    getConversation(id),
  );
  ipcMain.handle("conversations:create", (_event, docPath?: string) =>
    createConversation(docPath),
  );
  ipcMain.handle("conversations:list-for-doc", (_event, docPath: string) =>
    listDocConversations(docPath),
  );
  ipcMain.handle("conversations:rename", (_event, id: string, title: string) =>
    renameConversation(id, title),
  );
  ipcMain.handle("conversations:delete", async (_event, id: string) => {
    const slot = activeStreams.get(id);
    if (slot) {
      slot.controller.abort();
      await slot.cleanup.catch(() => {});
    }
    // Sweep image files referenced by this conversation before dropping the log.
    try {
      const record = await getConversation(id);
      const imagesDir = getImagesDir();
      const filenames = record.messages.flatMap((m) =>
        m.blocks
          .filter((b): b is PersistedImageBlock => b.type === "image")
          .map((b) => imageNameFromUrl(b.url))
          .filter((n): n is string => n !== null),
      );
      await Promise.all(
        filenames.map((name) => unlink(join(imagesDir, name)).catch(() => {})),
      );
    } catch (err) {
      console.warn("[conversations:delete] image cleanup failed:", err);
    }
    return deleteConversation(id);
  });
}

app.whenReady().then(() => {
  console.log("[storage] data dir =", getDataDir());
  handleImageProtocol();
  createWindow();
  registerIpcHandlers();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  for (const slot of activeStreams.values()) slot.controller.abort();
});
