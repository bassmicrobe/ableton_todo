// Track Notes — an Ableton Live extension.
//
// Adds a "Track Notes…" context-menu action to audio and MIDI tracks. Opening
// it shows a panel with a free-form memo and a TODO list for that track, plus a
// timestamped, restorable save history. You can also rename the track from the
// panel. When opened on a Group track's parent, a "子トラック" tab lists the
// notes/TODOs of its child tracks. Data is stored in SQLite, isolated per Live
// project (project.ts) and keyed by track name (store.ts).

import {
  initialize,
  Track,
  type ActivationContext,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import ui from "./ui.html";
import { resolveProject } from "./project.js";
import { Store, type ChildSummary, type SavePayload } from "./store.js";

const COMMAND_ID = "trackNotes.open";
const STATE_TOKEN = "/*__INITIAL_STATE__*/null";

/** Storage key for a track: its (trimmed) name, with a stable fallback. */
function keyOf(name: string): string {
  return name.trim() || "(unnamed track)";
}

export function activate(activation: ActivationContext): void {
  const context = initialize(activation, "1.0.0");

  context.commands.registerCommand(COMMAND_ID, (arg: unknown) => {
    openPanel(context, arg as Handle).catch((err) => {
      console.error("[Track Notes] failed to open panel:", err);
    });
  });

  (["AudioTrack", "MidiTrack"] as const).forEach((scope) => {
    context.ui.registerContextMenuAction(scope, "Track Notes…", COMMAND_ID).catch((err) => {
      console.error(`[Track Notes] failed to register action for ${scope}:`, err);
    });
  });
}

async function openPanel(context: ExtensionContext<"1.0.0">, handle: Handle): Promise<void> {
  const track = context.getObjectFromHandle(handle, Track);
  const originalName = track.name;
  const trackKey = keyOf(originalName);

  const project = await resolveProject(context.resources, context.environment);
  const store = new Store(project.dbPath);

  try {
    const state = store.loadTrack(trackKey, originalName);
    const children = collectChildren(context, track, store);

    const initial = JSON.stringify({
      project: project.label,
      isGroup: children.length > 0,
      children,
      ...state,
    })
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    const html = ui.replace(STATE_TOKEN, initial);

    const result = await context.ui.showModalDialog(
      `data:text/html,${encodeURIComponent(html)}`,
      820,
      640,
    );

    const payload = parsePayload(result);
    if (!payload || payload.action !== "save") return;

    // Apply an optional rename to the Live track, then migrate stored notes.
    const newName = (payload.name ?? originalName).trim();
    let saveKey = trackKey;
    let saveName = originalName;
    if (newName && newName !== originalName) {
      try {
        track.name = newName;
        saveName = newName;
        saveKey = keyOf(newName);
        store.renameTrackKey(trackKey, saveKey);
      } catch (err) {
        console.error("[Track Notes] rename failed, keeping original name:", err);
        saveKey = trackKey;
        saveName = originalName;
      }
    }
    store.saveTrack(saveKey, saveName, payload);
  } finally {
    store.close();
  }
}

/**
 * If `parent` is a Group track, returns read-only summaries for the tracks
 * grouped under it. Children are the song's tracks whose `groupTrack` resolves
 * to `parent`. Returns an empty array for non-group tracks or on any error.
 */
function collectChildren(
  context: ExtensionContext<"1.0.0">,
  parent: Track<"1.0.0">,
  store: Store,
): ChildSummary[] {
  try {
    const parentId = parent.handle.id;
    const summaries: ChildSummary[] = [];
    for (const t of context.application.song.tracks) {
      const group = t.groupTrack;
      if (group && group.handle.id === parentId) {
        summaries.push(store.loadChildSummary(keyOf(t.name), t.name));
      }
    }
    return summaries;
  } catch (err) {
    console.error("[Track Notes] failed to collect group children:", err);
    return [];
  }
}

function parsePayload(raw: string): SavePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SavePayload>;
    if (parsed.action !== "save" && parsed.action !== "cancel") return null;
    return {
      action: parsed.action,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
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
