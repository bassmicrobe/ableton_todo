import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  // node:sqlite, node:fs, etc. are provided by the Extension Host's Node runtime.
  external: ["node:sqlite"],
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  // The rich UI (ui.html) is inlined as a string and shipped inside the bundle,
  // then handed to showModalDialog() as a data: URL at runtime.
  loader: { ".html": "text" },
});
