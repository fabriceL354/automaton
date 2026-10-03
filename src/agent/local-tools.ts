import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import { mkdir, open, readdir, lstat } from "node:fs/promises";
import type { AutomatonTool } from "../types.js";

export function scoutWorkspaceRoot(): string {
  return path.join(os.homedir(), ".automaton", "scout-workspace");
}

const MAX_FILE_BYTES = 128 * 1024;

// Reject symlinks in every component, including the workspace itself. Files
// with multiple hard links are rejected too. Scout has no link-creation tool.
async function safePath(root: string, input: string, createParents = false): Promise<string> {
  if (!input.trim() || path.isAbsolute(input) || input.includes("\0")) {
    throw new Error("relative workspace path required");
  }
  const target = path.resolve(root, input);
  if (!target.startsWith(root + path.sep)) throw new Error("outside Scout workspace");
  const parent = path.dirname(target);
  const components = parent.slice(path.parse(parent).root.length).split(path.sep);
  let current = path.parse(parent).root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
    } catch (error: any) {
      if (error.code !== "ENOENT" || !createParents) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe file");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}

export function createLocalWorkspaceTools(root = scoutWorkspaceRoot()): AutomatonTool[] {
  root = path.resolve(root);
  return [
    {
      name: "list_files",
      description: "List files in Scout's private local workspace.",
      category: "vm", riskLevel: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        try {
          await safePath(root, ".probe", true);
          const items = await readdir(root, { withFileTypes: true });
          return items.length ? items.map(x => `${x.isSymbolicLink() ? "[blocked link]" : x.isDirectory() ? "[dir]" : "[file]"} ${x.name}`).join("\n") : "(workspace empty)";
        } catch { return "ERROR: unsafe workspace"; }
      },
    },
    {
      name: "read_file",
      description: "Read a workspace file. Required: path (e.g. MISSION.txt).",
      category: "vm", riskLevel: "safe",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async (args) => {
        if (typeof args.path !== "string") return "ERROR: path required";
        try {
          const target = await safePath(root, args.path);
          const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error("unsafe or oversized file");
            return await file.readFile("utf8");
          } finally { await file.close(); }
        } catch { return "ERROR: cannot read file; use a regular file inside Scout workspace (maximum 128 KiB)"; }
      },
    },
    {
      name: "write_file",
      description: "Write a workspace file. Required: path and content (e.g. rapport.txt).",
      category: "vm", riskLevel: "safe",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      execute: async (args) => {
        if (typeof args.path !== "string" || typeof args.content !== "string") return "ERROR: path and content required";
        if (Buffer.byteLength(args.content) > MAX_FILE_BYTES) return "ERROR: content exceeds 128 KiB";
        // Mission is supplied by the operator and must survive agent mistakes.
        if (path.resolve(root, args.path) === path.join(root, "MISSION.txt")) return "ERROR: MISSION.txt is read-only";
        try {
          const target = await safePath(root, args.path, true);
          const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe file");
            await file.truncate(0);
            await file.writeFile(args.content, "utf8");
          } finally { await file.close(); }
          return `File written: ${path.relative(root, target)}`;
        } catch { return "ERROR: cannot write file; use a regular file inside Scout workspace"; }
      },
    },
  ];
}
