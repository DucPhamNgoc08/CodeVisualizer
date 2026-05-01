import { PhpAstParser } from "./PhpAstParser";
import { FlowchartIR } from "../../../ir/ir";

let parserPromise: Promise<PhpAstParser> | null = null;

export function initPhpLanguageService(wasmPath: string): void {
  parserPromise = PhpAstParser.create(wasmPath);
}

export async function analyzePhpCode(
  code: string,
  position: number
): Promise<FlowchartIR> {
  if (!parserPromise) {
    throw new Error("PHP language service not initialized.");
  }
  const parser = await parserPromise;
  return parser.generateFlowchart(code, undefined, position);
}

export { PhpAstParser };
