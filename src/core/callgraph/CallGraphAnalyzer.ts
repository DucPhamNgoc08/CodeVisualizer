import * as path from "path";
import * as fs from "fs";
import { getTypeScriptParser } from "../language-services/typescript";
import { TsFunctionInfo } from "../language-services/typescript/TsAstParser";

/** A single function/method definition discovered in the workspace. */
export interface FunctionDef {
  name: string;
  file: string; // absolute path
  startIndex: number;
  endIndex: number;
  line: number; // 1-based, for display
  kind: TsFunctionInfo["kind"];
  calls: string[];
}

/** A node in the rendered usage graph (one per function name). */
export interface UsageGraphNode {
  id: string; // sanitized, stable id used as the Mermaid node id
  name: string; // original function name
  file: string; // absolute path of the representative definition
  relativePath: string;
  line: number; // 1-based
  startIndex: number;
  endIndex: number;
  isTarget: boolean;
}

export interface UsageGraphEdge {
  from: string; // node id (caller)
  to: string; // node id (callee)
}

export interface UsageGraph {
  nodes: UsageGraphNode[];
  edges: UsageGraphEdge[];
  /** True if the graph was truncated because the node limit was reached. */
  truncated: boolean;
  /** Number of distinct definitions found for the target name. */
  targetDefinitionCount: number;
}

/** Hard caps to keep large codebases responsive. */
const MAX_NODES = 200;
const MAX_DEPTH = 25;

/**
 * Scans TypeScript/JavaScript files in a workspace and builds a reverse call
 * (usage) graph: given a function, who calls it, recursively up the chain.
 *
 * Resolution is name-based (a call to `foo()` matches any definition named
 * `foo`). This is approximate but matches the lightweight, dependency-free
 * style of the rest of the extension and works well in practice.
 */
export class CallGraphAnalyzer {
  private workspaceRoot: string;
  private supportedExtensions = new Set([
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ]);

  private allDefs: FunctionDef[] = [];
  private defsByName: Map<string, FunctionDef[]> = new Map();
  /** callee name -> definitions whose body calls that name. */
  private callersByCallee: Map<string, FunctionDef[]> = new Map();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Parses every supported file and indexes definitions and call relations. */
  public async analyze(): Promise<void> {
    this.allDefs = [];
    this.defsByName.clear();
    this.callersByCallee.clear();

    const parser = await getTypeScriptParser();
    const files = await this.getAllSupportedFiles();

    for (const file of files) {
      let content: string;
      try {
        content = await fs.promises.readFile(file, "utf-8");
      } catch {
        continue;
      }

      let functions: TsFunctionInfo[];
      try {
        functions = parser.extractFunctionsWithCalls(content);
      } catch (error) {
        console.error(`CallGraphAnalyzer: failed to parse ${file}:`, error);
        continue;
      }

      for (const fn of functions) {
        const def: FunctionDef = {
          name: fn.name,
          file,
          startIndex: fn.startIndex,
          endIndex: fn.endIndex,
          line: fn.startLine + 1,
          kind: fn.kind,
          calls: fn.calls,
        };
        this.allDefs.push(def);

        const byName = this.defsByName.get(def.name);
        if (byName) {
          byName.push(def);
        } else {
          this.defsByName.set(def.name, [def]);
        }

        for (const callee of fn.calls) {
          const callers = this.callersByCallee.get(callee);
          if (callers) {
            callers.push(def);
          } else {
            this.callersByCallee.set(callee, [def]);
          }
        }
      }
    }
  }

  /**
   * Builds the usage graph for a target function: all (transitive) callers.
   * @param targetName the function name under the cursor.
   * @param targetFile absolute path of the file the cursor is in.
   * @param targetPosition byte offset of the cursor (to pick the right
   *        definition when several share the same name).
   */
  public buildUsageGraph(
    targetName: string,
    targetFile?: string,
    targetPosition?: number
  ): UsageGraph {
    const nodes = new Map<string, UsageGraphNode>();
    const edgeKeys = new Set<string>();
    const edges: UsageGraphEdge[] = [];
    let truncated = false;

    const targetDefs = this.defsByName.get(targetName) || [];

    const ensureNode = (name: string, isTarget: boolean): UsageGraphNode => {
      const id = this.sanitizeId(name);
      let node = nodes.get(id);
      if (node) {
        if (isTarget) {
          node.isTarget = true;
        }
        return node;
      }
      const def = this.pickDefinition(
        name,
        isTarget ? targetFile : undefined,
        isTarget ? targetPosition : undefined
      );
      node = {
        id,
        name,
        file: def?.file ?? targetFile ?? "",
        relativePath: def?.file
          ? path.relative(this.workspaceRoot, def.file)
          : "",
        line: def?.line ?? 0,
        startIndex: def?.startIndex ?? targetPosition ?? 0,
        endIndex: def?.endIndex ?? targetPosition ?? 0,
        isTarget,
      };
      nodes.set(id, node);
      return node;
    };

    const addEdge = (fromName: string, toName: string) => {
      const from = this.sanitizeId(fromName);
      const to = this.sanitizeId(toName);
      const key = `${from} ${to}`;
      if (edgeKeys.has(key)) {
        return;
      }
      edgeKeys.add(key);
      edges.push({ from, to });
    };

    ensureNode(targetName, true);

    // Breadth-first walk up the caller chain.
    const visited = new Set<string>([targetName]);
    let frontier: string[] = [targetName];
    let depth = 0;

    while (frontier.length > 0 && depth < MAX_DEPTH) {
      const next: string[] = [];
      for (const current of frontier) {
        const callers = this.callersByCallee.get(current) || [];
        for (const callerDef of callers) {
          const caller = callerDef.name;
          if (caller === current) {
            continue; // ignore direct self-recursion edges
          }
          ensureNode(caller, false);
          addEdge(caller, current);

          if (!visited.has(caller)) {
            if (nodes.size >= MAX_NODES) {
              truncated = true;
              continue;
            }
            visited.add(caller);
            next.push(caller);
          }
        }
      }
      frontier = next;
      depth++;
    }

    if (depth >= MAX_DEPTH && frontier.length > 0) {
      truncated = true;
    }

    return {
      nodes: [...nodes.values()],
      edges,
      truncated,
      targetDefinitionCount: targetDefs.length,
    };
  }

  /**
   * Chooses the most relevant definition for a name. When a cursor file and
   * position are provided, prefer the definition that contains it.
   */
  private pickDefinition(
    name: string,
    preferFile?: string,
    preferPosition?: number
  ): FunctionDef | undefined {
    const defs = this.defsByName.get(name);
    if (!defs || defs.length === 0) {
      return undefined;
    }

    if (preferFile !== undefined && preferPosition !== undefined) {
      const exact = defs.find(
        (d) =>
          d.file === preferFile &&
          preferPosition >= d.startIndex &&
          preferPosition <= d.endIndex
      );
      if (exact) {
        return exact;
      }
    }
    if (preferFile !== undefined) {
      const sameFile = defs.find((d) => d.file === preferFile);
      if (sameFile) {
        return sameFile;
      }
    }
    return defs[0];
  }

  private sanitizeId(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `fn_${cleaned}`;
  }

  private async getAllSupportedFiles(): Promise<string[]> {
    const files: string[] = [];

    const walkDir = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "build" ||
          entry.name === "out"
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          if (
            this.supportedExtensions.has(path.extname(entry.name)) &&
            !entry.name.endsWith(".d.ts")
          ) {
            files.push(fullPath);
          }
        }
      }
    };

    await walkDir(this.workspaceRoot);
    return files;
  }
}
