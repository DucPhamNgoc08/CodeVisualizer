import Parser from "web-tree-sitter"; // Changed from "tree-sitter"
import {
  FlowchartIR,
  FlowchartNode,
  FlowchartEdge,
  LocationMapEntry,
  NodeType,
  NodeCategory,
  SemanticNodeInfo,
} from "../../ir/ir";
import { StringProcessor } from "../utils/StringProcessor";
import { ProcessResult, LoopContext } from "./AstParserTypes";

export abstract class AbstractParser {
  protected nodeIdCounter = 0;
  protected locationMap: LocationMapEntry[] = [];
  protected debug = false;
  protected language:
    | "python"
    | "typescript"
    | "java"
    | "cpp"
    | "c"
    | "rust"
    | "go"
    | "php";

  // The parser instance is now required by the constructor
  protected parser: Parser;

  // Object pool for ProcessResult to reduce GC pressure
  private static processResultPool: ProcessResult[] = [];
  private static readonly MAX_POOL_SIZE = 50;

  protected constructor(
    parser: Parser,
    language:
      | "python"
      | "typescript"
      | "java"
      | "cpp"
      | "c"
      | "rust"
      | "go"
      | "php"
  ) {
    this.parser = parser;
    this.language = language;
  }

  protected readonly nodeStyles = {
    // Function boundaries
    terminator: "fill:#e8f5e8,stroke:#2e7d32,stroke-width:1.5px,color:#000",
    entry: "fill:#e8f5e8,stroke:#2e7d32,stroke-width:2px,color:#000",
    exit: "fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#000",
    return: "fill:#ffebee,stroke:#d32f2f,stroke-width:1.5px,color:#000",

    // Control flow
    decision: "fill:#fff3e0,stroke:#f57c00,stroke-width:1.5px,color:#000",
    condition: "fill:#fff8e1,stroke:#ff8f00,stroke-width:1.5px,color:#000",
    branch: "fill:#fff3e0,stroke:#ef6c00,stroke-width:1.5px,color:#000",

    // Loops
    loop_start: "fill:#e3f2fd,stroke:#1976d2,stroke-width:1.5px,color:#000",
    loop_end: "fill:#e1f5fe,stroke:#0288d1,stroke-width:1.5px,color:#000",
    loop_iteration: "fill:#e8f4fd,stroke:#0277bd,stroke-width:1.5px,color:#000",

    // Data operations
    assignment: "fill:#f3e5f5,stroke:#7b1fa2,stroke-width:1.5px,color:#000",
    declaration: "fill:#f8e7f8,stroke:#8e24aa,stroke-width:1.5px,color:#000",
    process: "fill:#f3e5f5,stroke:#7b1fa2,stroke-width:1.5px,color:#000",
    calculation: "fill:#ede7f6,stroke:#673ab7,stroke-width:1.5px,color:#000",

    // Function calls and invocations
    function_call: "fill:#e8eaf6,stroke:#3f51b5,stroke-width:1.5px,color:#000",
    method_call: "fill:#e7e9fd,stroke:#3949ab,stroke-width:1.5px,color:#000",
    hof: "fill:#e8eaf6,stroke:#3f51b5,stroke-width:1.5px,color:#000",

    // Exception handling
    try_start: "fill:#fff8e1,stroke:#f9a825,stroke-width:1.5px,color:#000",
    catch: "fill:#ffecb3,stroke:#ff8f00,stroke-width:1.5px,color:#000",
    finally: "fill:#fff3e0,stroke:#f57c00,stroke-width:1.5px,color:#000",
    throw: "fill:#ffebee,stroke:#e53935,stroke-width:1.5px,color:#000",
    exception: "fill:#ffebee,stroke:#d32f2f,stroke-width:1.5px,color:#000",

    // Control flow breaks
    break: "fill:#ffebee,stroke:#c62828,stroke-width:1.5px,color:#000",
    continue: "fill:#fff3e0,stroke:#ef6c00,stroke-width:1.5px,color:#000",
    break_continue: "fill:#ffe0b2,stroke:#f57c00,stroke-width:1.5px,color:#000",

    // Async operations
    async_operation:
      "fill:#e0f2f1,stroke:#00695c,stroke-width:1.5px,color:#000",
    await: "fill:#e0f7fa,stroke:#0097a7,stroke-width:1.5px,color:#000",
    promise: "fill:#e1f5fe,stroke:#0288d1,stroke-width:1.5px,color:#000",
    callback: "fill:#e8f5e8,stroke:#388e3c,stroke-width:1.5px,color:#000",

    // Special constructs
    special: "fill:#e3f2fd,stroke:#0d47a1,stroke-width:1.5px,color:#000",
    import: "fill:#f9fbe7,stroke:#689f38,stroke-width:1.5px,color:#000",
    export: "fill:#f1f8e9,stroke:#558b2f,stroke-width:1.5px,color:#000",
    class_definition:
      "fill:#fce4ec,stroke:#ad1457,stroke-width:1.5px,color:#000",
    interface: "fill:#f3e5f5,stroke:#7b1fa2,stroke-width:1.5px,color:#000",

    // Comments and documentation
    comment: "fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px,color:#666",
    documentation: "fill:#f8f9fa,stroke:#6c757d,stroke-width:1px,color:#666",

    // Default fallback
    default: "fill:#fafafa,stroke:#757575,stroke-width:1.5px,color:#000",
  };

  protected log(message: string, ...args: unknown[]) {
    if (this.debug) console.log(`[ASTParser] ${message}`, ...args);
  }

  protected generateNodeId(prefix: string): string {
    return `${prefix}_${this.nodeIdCounter++}`;
  }

  protected escapeString(str: string): string {
    return StringProcessor.escapeString(str);
  }

  // Object pooling for ProcessResult
  protected createProcessResult(
    nodes: FlowchartNode[] = [],
    edges: FlowchartEdge[] = [],
    entryNodeId?: string,
    exitPoints: { id: string; label?: string }[] = [],
    nodesConnectedToExit: Set<string> = new Set()
  ): ProcessResult {
    let result = AbstractParser.processResultPool.pop();
    if (!result) {
      result = {
        nodes: [],
        edges: [],
        entryNodeId: undefined,
        exitPoints: [],
        nodesConnectedToExit: new Set(),
      };
    } else {
      // Reset the pooled object
      result.nodes.length = 0;
      result.edges.length = 0;
      result.entryNodeId = undefined;
      result.exitPoints.length = 0;
      result.nodesConnectedToExit.clear();
    }

    result.nodes.push(...nodes);
    result.edges.push(...edges);
    result.entryNodeId = entryNodeId;
    result.exitPoints.push(...exitPoints);
    nodesConnectedToExit.forEach((id) => result.nodesConnectedToExit.add(id));

    return result;
  }

  // Return ProcessResult to pool for reuse
  protected recycleProcessResult(result: ProcessResult): void {
    if (
      AbstractParser.processResultPool.length < AbstractParser.MAX_POOL_SIZE
    ) {
      AbstractParser.processResultPool.push(result);
    }
  }

  protected getStyleForNodeType(nodeType: NodeType): string {
    switch (nodeType) {
      case NodeType.ENTRY:
        return this.nodeStyles.entry;
      case NodeType.EXIT:
        return this.nodeStyles.exit;
      case NodeType.RETURN:
        return this.nodeStyles.return;
      case NodeType.DECISION:
        return this.nodeStyles.decision;
      case NodeType.LOOP_START:
        return this.nodeStyles.loop_start;
      case NodeType.LOOP_END:
        return this.nodeStyles.loop_end;
      case NodeType.ASSIGNMENT:
        return this.nodeStyles.assignment;
      case NodeType.FUNCTION_CALL:
        return this.nodeStyles.function_call;
      case NodeType.METHOD_CALL:
        return this.nodeStyles.method_call;
      case NodeType.MACRO_CALL:
        return this.nodeStyles.function_call; // Same style as function calls
      case NodeType.EXCEPTION:
        return this.nodeStyles.exception;
      case NodeType.BREAK_CONTINUE:
        return this.nodeStyles.break_continue;
      case NodeType.ASYNC_OPERATION:
        return this.nodeStyles.async_operation;
      case NodeType.AWAIT:
        return this.nodeStyles.await;
      case NodeType.PANIC:
        return this.nodeStyles.throw; // Red/error style
      case NodeType.EARLY_RETURN_ERROR:
        return this.nodeStyles.return;
      case NodeType.PROCESS:
        return this.nodeStyles.process;
      default:
        return this.nodeStyles.default;
    }
  }

  // Enhanced node creation with semantic information
  protected createSemanticNode(
    id: string,
    label: string,
    nodeType: NodeType,
    syntaxNode?: Parser.SyntaxNode,
    shape?: "rect" | "diamond" | "round" | "stadium"
  ): FlowchartNode {
    const node: FlowchartNode = {
      id,
      label: this.escapeString(label),
      nodeType,
      nodeCategory: this.getCategoryForType(nodeType),
      shape: shape || this.getDefaultShapeForType(nodeType),
      style: this.getStyleForNodeType(nodeType),
      semanticInfo: syntaxNode
        ? this.extractSemanticInfo(syntaxNode)
        : undefined,
    };

    if (syntaxNode) {
      node.location = {
        start: syntaxNode.startIndex,
        end: syntaxNode.endIndex,
      };
    }

    return node;
  }

  protected getCategoryForType(nodeType: NodeType): NodeCategory {
    switch (nodeType) {
      case NodeType.ENTRY:
      case NodeType.EXIT:
        return NodeCategory.FUNCTION_BOUNDARY;

      case NodeType.DECISION:
      case NodeType.BREAK_CONTINUE:
        return NodeCategory.CONTROL_FLOW;

      case NodeType.ASSIGNMENT:
        return NodeCategory.DATA_OPERATION;

      case NodeType.EXCEPTION:
        return NodeCategory.EXCEPTION_HANDLING;

      case NodeType.LOOP_START:
      case NodeType.LOOP_END:
        return NodeCategory.LOOP_CONTROL;

      case NodeType.ASYNC_OPERATION:
        return NodeCategory.ASYNC_CONTROL;

      default:
        return NodeCategory.CONTROL_FLOW;
    }
  }

  protected getDefaultShapeForType(
    nodeType: NodeType
  ): "rect" | "diamond" | "round" | "stadium" {
    switch (nodeType) {
      case NodeType.ENTRY:
      case NodeType.EXIT:
        return "round";

      case NodeType.DECISION:
      case NodeType.LOOP_START:
        return "diamond";

      case NodeType.LOOP_END:
      case NodeType.EXCEPTION:
      case NodeType.RETURN:
        return "stadium";

      default:
        return "rect";
    }
  }

  protected extractSemanticInfo(
    syntaxNode: Parser.SyntaxNode
  ): SemanticNodeInfo {
    return {
      complexity: this.estimateComplexity(syntaxNode),
      importance: this.estimateImportance(syntaxNode),
      codeType: this.detectCodeType(syntaxNode),
      language: this.language,
    };
  }

  protected estimateComplexity(
    syntaxNode: Parser.SyntaxNode
  ): "low" | "medium" | "high" {
    // Simple heuristic based on node type and child count
    const childCount = syntaxNode.childCount;
    const nodeType = syntaxNode.type;

    if (
      nodeType.includes("if") ||
      nodeType.includes("loop") ||
      nodeType.includes("try")
    ) {
      return childCount > 5 ? "high" : "medium";
    }

    return childCount > 3 ? "medium" : "low";
  }

  protected estimateImportance(
    syntaxNode: Parser.SyntaxNode
  ): "low" | "medium" | "high" {
    const nodeType = syntaxNode.type;

    if (
      nodeType.includes("return") ||
      nodeType.includes("throw") ||
      nodeType.includes("break")
    ) {
      return "high";
    }

    if (nodeType.includes("if") || nodeType.includes("call")) {
      return "medium";
    }

    return "low";
  }

  protected detectCodeType(
    syntaxNode: Parser.SyntaxNode
  ): "synchronous" | "asynchronous" | "callback" {
    const text = syntaxNode.text.toLowerCase();

    if (
      text.includes("async") ||
      text.includes("await") ||
      text.includes("promise")
    ) {
      return "asynchronous";
    }

    if (text.includes("callback") || text.includes("=>")) {
      return "callback";
    }

    return "synchronous";
  }

  // Convenience methods for creating specific node types
  protected createEntryNode(
    id: string,
    label: string = "Start"
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.ENTRY,
      undefined,
      "round"
    );
  }

  protected createExitNode(id: string, label: string = "End"): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.EXIT,
      undefined,
      "round"
    );
  }

  protected createDecisionNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.DECISION,
      syntaxNode,
      "diamond"
    );
  }

  protected createAssignmentNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.ASSIGNMENT,
      syntaxNode,
      "rect"
    );
  }

  protected createFunctionCallNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.FUNCTION_CALL,
      syntaxNode,
      "rect"
    );
  }

  protected createLoopStartNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.LOOP_START,
      syntaxNode,
      "diamond"
    );
  }

  protected createLoopEndNode(
    id: string,
    label: string = "Loop End",
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.LOOP_END,
      syntaxNode,
      "stadium"
    );
  }

  protected createReturnNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.RETURN,
      syntaxNode,
      "stadium"
    );
  }

  protected createExceptionNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.EXCEPTION,
      syntaxNode,
      "stadium"
    );
  }

  protected createBreakContinueNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.BREAK_CONTINUE,
      syntaxNode,
      "rect"
    );
  }

  protected createAsyncNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.ASYNC_OPERATION,
      syntaxNode,
      "rect"
    );
  }

  protected createProcessNode(
    id: string,
    label: string,
    syntaxNode?: Parser.SyntaxNode
  ): FlowchartNode {
    return this.createSemanticNode(
      id,
      label,
      NodeType.PROCESS,
      syntaxNode,
      "rect"
    );
  }

  // Enhanced method for creating nodes with custom styles
  protected createStyledNode(
    id: string,
    label: string,
    styleKey: keyof typeof AbstractParser.prototype.nodeStyles,
    syntaxNode?: Parser.SyntaxNode,
    shape?: "rect" | "diamond" | "round" | "stadium"
  ): FlowchartNode {
    const node: FlowchartNode = {
      id,
      label: this.escapeString(label),
      shape: shape || "rect",
      style: this.nodeStyles[styleKey],
      nodeType: NodeType.PROCESS, // Default type, can be overridden
      nodeCategory: NodeCategory.CONTROL_FLOW,
    };

    if (syntaxNode) {
      node.location = {
        start: syntaxNode.startIndex,
        end: syntaxNode.endIndex,
      };
      node.semanticInfo = this.extractSemanticInfo(syntaxNode);
    }

    return node;
  }


  abstract listFunctions(sourceCode: string): string[];
  abstract findFunctionAtPosition(
    sourceCode: string,
    position: number
  ): string | undefined;
  abstract generateFlowchart(
    sourceCode: string,
    functionName?: string,
    position?: number
  ): FlowchartIR;

  protected processBlock(
    blockNode: Parser.SyntaxNode | null,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    if (!blockNode) {
      return this.createProcessResult();
    }

    // Pre-filter statements for better performance
    const statements = blockNode.namedChildren.filter(
      (s) =>
        ![
          "pass_statement",
          "comment",
          "elif_clause",
          "else_clause",
          "empty_statement",
        ].includes(s.type)
    );

    if (statements.length === 0) {
      return this.createProcessResult();
    }

    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    let entryNodeId: string | undefined;
    let lastExitPoints: { id: string; label?: string }[] = [];

    // Process statements with improved loop
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const result = this.processStatement(
        statement,
        exitId,
        loopContext,
        finallyContext
      );

      nodes.push(...result.nodes);
      edges.push(...result.edges);
      result.nodesConnectedToExit.forEach((n) => nodesConnectedToExit.add(n));

      if (!entryNodeId) entryNodeId = result.entryNodeId;
      if (lastExitPoints.length > 0 && result.entryNodeId) {
        for (const exitPoint of lastExitPoints) {
          edges.push({
            from: exitPoint.id,
            to: result.entryNodeId,
            label: exitPoint.label,
          });
        }
      }
      lastExitPoints = result.exitPoints;
    }

    return this.createProcessResult(
      nodes,
      edges,
      entryNodeId,
      lastExitPoints,
      nodesConnectedToExit
    );
  }

  protected abstract processStatement(
    statement: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult;

  protected processDefaultStatement(
    statement: Parser.SyntaxNode
  ): ProcessResult {
    const nodeId = this.generateNodeId("stmt");

    // Try to determine the appropriate node type based on syntax
    const nodeType = this.inferNodeTypeFromSyntax(statement);
    const node = this.createSemanticNode(
      nodeId,
      statement.text,
      nodeType,
      statement
    );

    this.locationMap.push({
      start: statement.startIndex,
      end: statement.endIndex,
      nodeId,
    });

    return this.createProcessResult([node], [], nodeId, [{ id: nodeId }]);
  }

  // Helper method to infer node type from syntax node
  protected inferNodeTypeFromSyntax(syntaxNode: Parser.SyntaxNode): NodeType {
    const nodeType = syntaxNode.type.toLowerCase();

    if (nodeType.includes("assignment") || nodeType.includes("=")) {
      return NodeType.ASSIGNMENT;
    }

    if (nodeType.includes("call") || nodeType.includes("invoke")) {
      return NodeType.FUNCTION_CALL;
    }

    if (nodeType.includes("if") || nodeType.includes("condition")) {
      return NodeType.DECISION;
    }

    if (nodeType.includes("return")) {
      return NodeType.RETURN;
    }

    if (nodeType.includes("break") || nodeType.includes("continue")) {
      return NodeType.BREAK_CONTINUE;
    }

    if (
      nodeType.includes("try") ||
      nodeType.includes("catch") ||
      nodeType.includes("throw")
    ) {
      return NodeType.EXCEPTION;
    }

    if (nodeType.includes("async") || nodeType.includes("await")) {
      return NodeType.ASYNC_OPERATION;
    }

    if (
      nodeType.includes("for") ||
      nodeType.includes("while") ||
      nodeType.includes("loop")
    ) {
      return NodeType.LOOP_START;
    }

    // Default to process for general statements
    return NodeType.PROCESS;
  }

  // Memory management utilities
  protected resetState(): void {
    this.nodeIdCounter = 0;
    this.locationMap.length = 0;
  }

  // Performance monitoring
  protected measurePerformance<T>(operation: string, fn: () => T): T {
    if (this.debug) {
      const start = performance.now();
      const result = fn();
      const end = performance.now();
      this.log(`${operation} took ${(end - start).toFixed(2)}ms`);
      return result;
    }
    return fn();
  }

  // Cleanup method to be called when parser is no longer needed
  static cleanup(): void {
    AbstractParser.processResultPool.length = 0;
    StringProcessor.clearCache();
  }
}
