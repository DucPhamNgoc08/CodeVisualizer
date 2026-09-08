import { TsAstParser } from "./TsAstParser";
import { FlowchartIR } from "../../../ir/ir";

let parserPromise: Promise<TsAstParser> | null = null;

/**
 * Initializes the TypeScript language service.
 * @param wasmPath The absolute path to the tree-sitter-typescript.wasm file.
 */
export function initTypeScriptLanguageService(wasmPath: string) {
  parserPromise = TsAstParser.create(wasmPath);
}

/**
 * Analyzes TypeScript code.
 */
export async function analyzeTypeScriptCode(
  code: string,
  position: number
): Promise<FlowchartIR> {
  if (!parserPromise) {
    throw new Error("TypeScript language service not initialized.");
  }
  const parser = await parserPromise;
  return parser.generateFlowchart(code, undefined, position);
}

/**
 * Returns the initialized shared TypeScript parser instance. Used by features
 * that need lower-level parsing (e.g. cross-file call graphs).
 */
export async function getTypeScriptParser(): Promise<TsAstParser> {
  if (!parserPromise) {
    throw new Error("TypeScript language service not initialized.");
  }
  return parserPromise;
}

export { TsAstParser };
