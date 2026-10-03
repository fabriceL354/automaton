import path from "node:path";
import os from "node:os";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { AutomatonTool } from "../types.js";

const ROOT = path.join(os.homedir(), ".automaton", "scout-workspace");

function safePath(input: string): string | null {
  const target = path.resolve(ROOT, input || ".");
  return target === ROOT || target.startsWith(ROOT + path.sep) ? target : null;
}

export function createLocalWorkspaceTools(): AutomatonTool[] {
  return [
    {
      name: "list_files",
      description: "List files in Scout's private local workspace.",
      category: "vm",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await mkdir(ROOT, { recursive: true });
        const items = await readdir(ROOT, { withFileTypes: true });
        return items.length ? items.map(x => `${x.isDirectory() ? "[dir]" : "[file]"} ${x.name}`).join("\n") : "(workspace empty)";
      },
    },
    {
      name: "read_file",
      description: "Read a workspace file. REQUIRED argument: path. Example path: MISSION.txt.",
      category: "vm",
      riskLevel: "safe",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args) => {
        if (typeof args.path !== "string" || !args.path.trim()) return "ERROR: path required. Retry with MISSION.txt.";
        const target = safePath(args.path as string);
        if (!target) return "Blocked: outside Scout workspace.";
        try { return await readFile(target, "utf8"); }
        catch { return `ERROR: cannot read ${args.path}`; }
      },
    },
    {
      name: "write_file",
      description: "Write a workspace file. REQUIRED arguments: path and content. Example path: rapport.txt.",
      category: "vm",
      riskLevel: "safe",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      execute: async (args) => {
        if (typeof args.path !== "string" || !args.path.trim() || typeof args.content !== "string") return "ERROR: path and content required. Use rapport.txt and Scout local operationnel.";
        const target = safePath(args.path as string);
        if (!target) return "Blocked: outside Scout workspace.";
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, String(args.content ?? ""), "utf8");
        return `File written: ${path.relative(ROOT, target)}`;
      },
    },
  ];
}
