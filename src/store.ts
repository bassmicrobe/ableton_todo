// SQLite-backed storage for per-track notes, TODOs and save history.
//
// Uses Node's built-in `node:sqlite` (DatabaseSync), so there is no native
// addon to compile against the Extension Host's Node ABI. The database file is
// scoped per Live project (see project.ts) — one .sqlite file per project.
//
// Everything in this module is synchronous: DatabaseSync runs queries on the
// calling thread, which is fine because each open/save is a short burst around
// the modal dialog.

import { DatabaseSync } from "node:sqlite";

/** A single TODO item. `id` is null for items created in the UI but not yet persisted. */
export interface Todo {
  id: number | null;
  text: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One save event — a full snapshot of the track's notes at the time of saving. */
export interface HistoryEntry {
  id: number;
  savedAt: string;
  memo: string;
  todos: Todo[];
  summary: string;
}

/** The complete state for one track, handed to the UI. */
export interface TrackState {
  trackKey: string;
  name: string;
  /** When this track was first recorded by the extension (ISO-8601), or null. */
  createdAt: string | null;
  memo: string;
  memoUpdatedAt: string | null;
  todos: Todo[];
  history: HistoryEntry[];
}

/** Read-only digest of a child track, shown when opening a group's parent. */
export interface ChildSummary {
  trackKey: string;
  name: string;
  createdAt: string | null;
  memo: string;
  todoActive: number;
  todoTotal: number;
  todos: { text: string; done: boolean }[];
}

/** What the UI returns when the dialog closes. */
export interface SavePayload {
  action: "save" | "cancel";
  /** Possibly-edited track name. Renames the Live track and migrates stored notes. */
  name?: string;
  memo: string;
  todos: { id: number | null; text: string; done: boolean }[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  track_key  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memos (
  track_key  TEXT PRIMARY KEY,
  text       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_key  TEXT NOT NULL,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_track ON todos(track_key);
CREATE TABLE IF NOT EXISTS history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  track_key      TEXT NOT NULL,
  saved_at       TEXT NOT NULL,
  memo_snapshot  TEXT NOT NULL,
  todos_snapshot TEXT NOT NULL,
  summary        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_track ON history(track_key);
`;

function now(): string {
  return new Date().toISOString();
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Loads the full state for a track, creating empty rows on first access. */
  loadTrack(trackKey: string, name: string): TrackState {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tracks (track_key, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(track_key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(trackKey, name, ts, ts);

    const trackRow = this.db
      .prepare("SELECT created_at FROM tracks WHERE track_key = ?")
      .get(trackKey) as { created_at: string } | undefined;

    const memoRow = this.db
      .prepare("SELECT text, updated_at FROM memos WHERE track_key = ?")
      .get(trackKey) as { text: string; updated_at: string } | undefined;

    const todoRows = this.db
      .prepare(
        "SELECT id, text, done, created_at, updated_at FROM todos WHERE track_key = ? ORDER BY done ASC, id ASC",
      )
      .all(trackKey) as {
      id: number;
      text: string;
      done: number;
      created_at: string;
      updated_at: string;
    }[];

    const historyRows = this.db
      .prepare(
        "SELECT id, saved_at, memo_snapshot, todos_snapshot, summary FROM history WHERE track_key = ? ORDER BY id DESC LIMIT 200",
      )
      .all(trackKey) as {
      id: number;
      saved_at: string;
      memo_snapshot: string;
      todos_snapshot: string;
      summary: string;
    }[];

    return {
      trackKey,
      name,
      createdAt: trackRow?.created_at ?? null,
      memo: memoRow?.text ?? "",
      memoUpdatedAt: memoRow?.updated_at ?? null,
      todos: todoRows.map((r) => ({
        id: r.id,
        text: r.text,
        done: r.done !== 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      history: historyRows.map((r) => ({
        id: r.id,
        savedAt: r.saved_at,
        memo: r.memo_snapshot,
        todos: JSON.parse(r.todos_snapshot) as Todo[],
        summary: r.summary,
      })),
    };
  }

  /**
   * Read-only digest for a child track of a group. Does NOT create rows, so
   * listing a group's children never registers tracks that were never opened.
   */
  loadChildSummary(trackKey: string, name: string): ChildSummary {
    const trackRow = this.db
      .prepare("SELECT created_at FROM tracks WHERE track_key = ?")
      .get(trackKey) as { created_at: string } | undefined;
    const memoRow = this.db
      .prepare("SELECT text FROM memos WHERE track_key = ?")
      .get(trackKey) as { text: string } | undefined;
    const todoRows = this.db
      .prepare("SELECT text, done FROM todos WHERE track_key = ? ORDER BY done ASC, id ASC")
      .all(trackKey) as { text: string; done: number }[];

    const todos = todoRows.map((r) => ({ text: r.text, done: r.done !== 0 }));
    return {
      trackKey,
      name,
      createdAt: trackRow?.created_at ?? null,
      memo: memoRow?.text ?? "",
      todoActive: todos.filter((t) => !t.done).length,
      todoTotal: todos.length,
      todos,
    };
  }

  /**
   * Moves every row from `oldKey` to `newKey` (used when a track is renamed
   * from the panel). Any data already under `newKey` is overwritten. No-op when
   * the keys are equal.
   */
  renameTrackKey(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;
    this.db.exec("BEGIN");
    try {
      for (const table of ["tracks", "memos", "todos", "history"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE track_key = ?`).run(newKey);
        this.db.prepare(`UPDATE ${table} SET track_key = ? WHERE track_key = ?`).run(newKey, oldKey);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Persists the UI payload: upserts the memo, reconciles the TODO list
   * (insert new / update changed / delete removed), and appends a history
   * snapshot. Runs in a single transaction so a save is all-or-nothing.
   */
  saveTrack(trackKey: string, name: string, payload: SavePayload): TrackState {
    const ts = now();
    const previous = this.readRaw(trackKey);
    const prevTodoById = new Map(previous.todos.filter((t) => t.id != null).map((t) => [t.id as number, t]));

    this.db.exec("BEGIN");
    try {
      // --- memo ---
      const memoChanged = previous.memo !== payload.memo;
      this.db
        .prepare(
          `INSERT INTO memos (track_key, text, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(track_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        )
        .run(trackKey, payload.memo, memoChanged ? ts : previous.memoUpdatedAt ?? ts);

      // --- todos: reconcile ---
      const keepIds = new Set<number>();
      let added = 0;
      let updated = 0;
      for (const incoming of payload.todos) {
        const text = incoming.text;
        const done = incoming.done ? 1 : 0;
        if (incoming.id != null && prevTodoById.has(incoming.id)) {
          const prev = prevTodoById.get(incoming.id)!;
          keepIds.add(incoming.id);
          const changed = prev.text !== text || prev.done !== incoming.done;
          if (changed) {
            this.db
              .prepare("UPDATE todos SET text = ?, done = ?, updated_at = ? WHERE id = ?")
              .run(text, done, ts, incoming.id);
            updated++;
          }
        } else {
          const info = this.db
            .prepare(
              "INSERT INTO todos (track_key, text, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(trackKey, text, done, ts, ts);
          keepIds.add(Number(info.lastInsertRowid));
          added++;
        }
      }
      let removed = 0;
      for (const prev of previous.todos) {
        if (prev.id != null && !keepIds.has(prev.id)) {
          this.db.prepare("DELETE FROM todos WHERE id = ?").run(prev.id);
          removed++;
        }
      }

      // --- track name refresh ---
      this.db.prepare("UPDATE tracks SET name = ?, updated_at = ? WHERE track_key = ?").run(name, ts, trackKey);

      // --- history snapshot ---
      const finalTodos = this.db
        .prepare("SELECT id, text, done, created_at, updated_at FROM todos WHERE track_key = ? ORDER BY id ASC")
        .all(trackKey) as {
        id: number;
        text: string;
        done: number;
        created_at: string;
        updated_at: string;
      }[];
      const snapshotTodos: Todo[] = finalTodos.map((r) => ({
        id: r.id,
        text: r.text,
        done: r.done !== 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      const summary = buildSummary({ memoChanged, added, updated, removed, todoCount: snapshotTodos.length });
      this.db
        .prepare(
          "INSERT INTO history (track_key, saved_at, memo_snapshot, todos_snapshot, summary) VALUES (?, ?, ?, ?, ?)",
        )
        .run(trackKey, ts, payload.memo, JSON.stringify(snapshotTodos), summary);

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return this.loadTrack(trackKey, name);
  }

  private readRaw(trackKey: string): TrackState {
    const memoRow = this.db
      .prepare("SELECT text, updated_at FROM memos WHERE track_key = ?")
      .get(trackKey) as { text: string; updated_at: string } | undefined;
    const todoRows = this.db
      .prepare("SELECT id, text, done, created_at, updated_at FROM todos WHERE track_key = ?")
      .all(trackKey) as {
      id: number;
      text: string;
      done: number;
      created_at: string;
      updated_at: string;
    }[];
    return {
      trackKey,
      name: "",
      memo: memoRow?.text ?? "",
      memoUpdatedAt: memoRow?.updated_at ?? null,
      todos: todoRows.map((r) => ({
        id: r.id,
        text: r.text,
        done: r.done !== 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      history: [],
    };
  }
}

function buildSummary(s: {
  memoChanged: boolean;
  added: number;
  updated: number;
  removed: number;
  todoCount: number;
}): string {
  const parts: string[] = [];
  if (s.memoChanged) parts.push("memo updated");
  if (s.added) parts.push(`+${s.added} todo`);
  if (s.updated) parts.push(`~${s.updated} todo`);
  if (s.removed) parts.push(`-${s.removed} todo`);
  if (parts.length === 0) parts.push("saved (no changes)");
  return `${parts.join(", ")} · ${s.todoCount} total`;
}
