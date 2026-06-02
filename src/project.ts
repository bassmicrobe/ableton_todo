// Resolves a stable, per-project storage location.
//
// The SDK (1.0.0-beta.0) exposes no API for the current Live Set's path or id.
// The one signal we have is `resources.importIntoProject(file)`, which copies a
// file into the *current project folder* and returns the path of the copy. We
// use that returned path to derive a stable key for the project, then keep the
// SQLite database inside the extension's own `storageDirectory` (always
// writable), namespaced by that key — so notes are isolated per project without
// writing a database file into the user's project tree.
//
// Caveats (documented in README):
//   * The probe leaves one small marker file in the project (the file we import).
//   * If the project hasn't been saved yet, or the import fails, we fall back to
//     a single shared "default" database.
//   * "Save As" to a new location during the same session is not re-detected
//     until Live is relaunched (the result is cached per session).

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Environment, Resources } from "@ableton-extensions/sdk";

export interface ProjectStorage {
  /** Stable identifier for the current project (or "default"). */
  key: string;
  /** Human-readable hint shown in the UI (the detected project folder). */
  label: string;
  /** Absolute path to the per-project SQLite database. */
  dbPath: string;
}

const MARKER_NAME = "track-notes-probe.txt";

/** Cached for the lifetime of the extension process — the project rarely changes mid-session. */
let cached: ProjectStorage | null = null;

export async function resolveProject(
  resources: Resources<"1.0.0">,
  environment: Environment<"1.0.0">,
): Promise<ProjectStorage> {
  if (cached) return cached;

  const storageRoot = environment.storageDirectory ?? environment.tempDirectory ?? tmpdir();
  const dbDir = path.join(storageRoot, "projects");
  fs.mkdirSync(dbDir, { recursive: true });

  let key = "default";
  let label = "(no project detected — shared notes)";

  try {
    const probeSrc = path.join(environment.tempDirectory ?? tmpdir(), MARKER_NAME);
    fs.writeFileSync(
      probeSrc,
      "This file marks the folder for the 'Track Notes & TODO' Live extension. Safe to delete.\n",
    );
    const importedPath = await resources.importIntoProject(probeSrc);
    const projectDir = path.dirname(importedPath);
    key = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
    label = projectDir;
  } catch {
    // Project not saved / import unsupported — fall back to the shared database.
  }

  cached = { key, label, dbPath: path.join(dbDir, `${key}.sqlite`) };
  return cached;
}
