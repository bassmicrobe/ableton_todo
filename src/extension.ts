// Track Notes & TODO — an Ableton Live extension.
//
// Adds a "Notes & TODO…" context-menu action to audio and MIDI tracks. Opening
// it shows a rich modal panel where you can keep a free-form memo and a TODO
// list for that track. Every save is timestamped and snapshotted into a history
// you can browse and restore from. Data is stored in SQLite, isolated per Live
// project (see project.ts) and keyed by track name (see store.ts).

import {
  initialize,
  Track,
  type ActivationContext,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import ui from "./ui.html";
import { resolveProject } from "./project.js";
import { Store, type SavePayload } from "./store.js";

const COMMAND_ID = "trackNotes.open";
const STATE_TOKEN = "/*__INITIAL_STATE__*/null";

export function activate(activation: ActivationContext): void {
  const context = initialize(activation, "1.0.0");

  context.commands.registerCommand(COMMAND_ID, (arg: unknown) => {
    openPanel(context, arg as Handle).catch((err) => {
      console.error("[Track Notes] failed to open panel:", err);
    });
  });

  (["AudioTrack", "MidiTrack"] as const).forEach((scope) => {
    context.ui.registerContextMenuAction(scope, "Notes & TODO…", COMMAND_ID).catch((err) => {
      console.error(`[Track Notes] failed to register action for ${scope}:`, err);
    });
  });
}

async function openPanel(context: ExtensionContext<"1.0.0">, handle: Handle): Promise<void> {
  const track = context.getObjectFromHandle(handle, Track);
  const name = track.name;
  // Per-project DB keys by track name. Empty names collapse to a single bucket.
  const trackKey = name.trim() || "(unnamed track)";

  const project = await resolveProject(context.resources, context.environment);
  const store = new Store(project.dbPath);

  try {
    const state = store.loadTrack(trackKey, name);
    const initial = JSON.stringify({ project: project.label, ...state })
      // The JSON is embedded inside a <script> tag, so neutralise sequences that
      // could terminate the script or break the parser. These stay valid JSON.
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    const html = ui.replace(STATE_TOKEN, initial);

    const result = await context.ui.showModalDialog(
      `data:text/html,${encodeURIComponent(html)}`,
      760,
      600,
    );

    const payload = parsePayload(result);
    if (payload && payload.action === "save") {
      store.saveTrack(trackKey, name, payload);
    }
  } finally {
    store.close();
  }
}

function parsePayload(raw: string): SavePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SavePayload>;
    if (parsed.action !== "save" && parsed.action !== "cancel") return null;
    return {
      action: parsed.action,
      memo: typeof parsed.memo === "string" ? parsed.memo : "",
      todos: Array.isArray(parsed.todos)
        ? parsed.todos.map((t) => ({
            id: typeof t.id === "number" ? t.id : null,
            text: String(t.text ?? ""),
            done: Boolean(t.done),
          }))
        : [],
    };
  } catch {
    return null;
  }
}
