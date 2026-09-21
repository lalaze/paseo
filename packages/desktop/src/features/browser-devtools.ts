import { BrowserWindow, WebContentsView, ipcMain, type WebContents } from "electron";
import { z } from "zod";
import { getPaseoBrowserWebContentsForHostWindow } from "./browser-webviews/index.js";

const BoundsSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .nullable();
const IdSchema = z.string().trim().min(1).max(256);

interface DevToolsInstance {
  sender: WebContents;
  window: BrowserWindow;
  inspected: WebContents;
  view: WebContentsView;
  dispose(): void;
}

const instances = new Map<string, DevToolsInstance>();

function key(sender: WebContents, instanceId: string): string {
  return `${sender.id}:${instanceId}`;
}

export async function createBrowserDevTools(input: {
  sender: WebContents;
  browserId: string;
  instanceId: string;
}): Promise<void> {
  const { sender, browserId, instanceId } = input;
  const owner = BrowserWindow.fromWebContents(sender);
  const browser = getPaseoBrowserWebContentsForHostWindow(browserId, sender.id);
  if (!owner || owner.webContents !== sender || !browser) {
    throw new Error("Browser is not available in this window");
  }
  const window = owner;
  const inspected = browser;
  const instanceKey = key(sender, instanceId);
  instances.get(instanceKey)?.dispose();
  inspected.closeDevTools();
  // DevTools requires a fresh WebContents that has never navigated. A renderer
  // <webview> has already loaded its src by the time it can be registered.
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setVisible(false);
  window.contentView.addChildView(view);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  inspected.setDevToolsWebContents(view.webContents);

  const disconnected = () => {
    if (!sender.isDestroyed())
      sender.send("paseo:event:browser-devtools-disconnected", { instanceId });
    dispose();
  };
  const focused = () => {
    if (!sender.isDestroyed()) sender.send("paseo:event:browser-devtools-focused", { instanceId });
  };
  function navigated(event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) {
    if (event.isMainFrame && !event.isSameDocument) dispose();
  }
  function dispose() {
    if (!instances.delete(instanceKey)) return;
    sender.removeListener("destroyed", dispose);
    sender.removeListener("render-process-gone", dispose);
    sender.removeListener("did-start-navigation", navigated);
    inspected.removeListener("destroyed", disconnected);
    inspected.removeListener("devtools-closed", disconnected);
    if (!inspected.isDestroyed()) inspected.closeDevTools();
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  instances.set(instanceKey, { sender, window, inspected, view, dispose });
  sender.once("destroyed", dispose);
  sender.once("render-process-gone", dispose);
  sender.on("did-start-navigation", navigated);
  inspected.once("destroyed", disconnected);
  inspected.once("devtools-closed", disconnected);
  view.webContents.on("focus", focused);
  view.webContents.once("render-process-gone", disconnected);

  try {
    await new Promise<void>((resolve, reject) => {
      function cleanup() {
        clearTimeout(timeout);
        inspected.removeListener("devtools-opened", opened);
        view.webContents.removeListener("destroyed", destroyed);
      }
      function opened() {
        cleanup();
        resolve();
      }
      function destroyed() {
        cleanup();
        reject(new Error("DevTools was closed"));
      }
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("DevTools did not open"));
      }, 10_000);
      inspected.once("devtools-opened", opened);
      view.webContents.once("destroyed", destroyed);
      inspected.openDevTools({ mode: "detach", activate: false });
    });
  } catch (error) {
    dispose();
    throw error;
  }
}

export function updateBrowserDevTools(input: {
  sender: WebContents;
  instanceId: string;
  bounds: z.infer<typeof BoundsSchema>;
}): void {
  const instance = instances.get(key(input.sender, input.instanceId));
  if (!instance) return;
  if (!input.bounds) {
    instance.view.setVisible(false);
    return;
  }
  const zoom = input.sender.getZoomFactor();
  const { x, y, width, height } = input.bounds;
  instance.view.setBounds({
    x: Math.round(x * zoom),
    y: Math.round(y * zoom),
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
  });
  instance.view.setVisible(true);
}

export function destroyBrowserDevTools(sender: WebContents, instanceId: string): void {
  instances.get(key(sender, instanceId))?.dispose();
}

export function registerBrowserDevToolsIpc(): void {
  ipcMain.handle(
    "paseo:browser:devtools:create",
    (event, browserId: unknown, instanceId: unknown) =>
      createBrowserDevTools({
        sender: event.sender,
        browserId: IdSchema.parse(browserId),
        instanceId: IdSchema.parse(instanceId),
      }),
  );
  ipcMain.handle("paseo:browser:devtools:update", (event, instanceId: unknown, bounds: unknown) =>
    updateBrowserDevTools({
      sender: event.sender,
      instanceId: IdSchema.parse(instanceId),
      bounds: BoundsSchema.parse(bounds),
    }),
  );
  ipcMain.handle("paseo:browser:devtools:destroy", (event, instanceId: unknown) =>
    destroyBrowserDevTools(event.sender, IdSchema.parse(instanceId)),
  );
}
