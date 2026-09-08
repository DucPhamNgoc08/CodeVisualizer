import Parser from "web-tree-sitter";
import { AbstractParser } from "../../common/AbstractParser";
import {
  FlowchartIR,
  FlowchartNode,
  FlowchartEdge,
  NodeType,
} from "../../../ir/ir";
import { ProcessResult, LoopContext } from "../../common/AstParserTypes";
import { ensureParserInit } from "../common/ParserInit";

/**
 * Raw information about a single function/method definition together with the
 * names of the functions it calls. Used to build cross-file call graphs.
 */
export interface TsFunctionInfo {
  name: string;
  kind: "function" | "method" | "arrow";
  startIndex: number;
  endIndex: number;
  /** 0-based line number where the definition starts. */
  startLine: number;
  /** Distinct names of functions/methods called within this definition's body. */
  calls: string[];
}

export class TsAstParser extends AbstractParser {
  private currentFunctionIsArrow = false;

  private constructor(parser: Parser) {
    super(parser, "typescript");
  }

  /**
   * Asynchronously creates and initializes an instance of TsAstParser.
   * This is the required entry point for creating a parser instance.
   * @param wasmPath The file path to the tree-sitter-typescript.wasm file.
   * @returns A promise that resolves to a new TsAstParser instance.
   */
  public static async create(wasmPath: string): Promise<TsAstParser> {
    await ensureParserInit();
    const language = await Parser.Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(language);
    return new TsAstParser(parser);
  }

  public listFunctions(sourceCode: string): string[] {
    return this.measurePerformance("listFunctions", () => {
      const tree = this.parser.parse(sourceCode);

      // Get regular function declarations
      const funcNames = tree.rootNode
        .descendantsOfType("function_declaration")
        .map(
          (f: Parser.SyntaxNode) =>
            f.childForFieldName("name")?.text || "[anonymous]"
        );

      // Get method definitions in classes
      const methodNames = tree.rootNode
        .descendantsOfType("method_definition")
        .map(
          (m: Parser.SyntaxNode) =>
            m.childForFieldName("name")?.text || "[anonymous method]"
        );

      // Get arrow functions assigned to variables/constants
      const arrowFunctionNames = tree.rootNode
        .descendantsOfType("variable_declarator")
        .filter((v) => {
          const value = v.childForFieldName("value");
          return value?.type === "arrow_function";
        })
        .map((v) => v.childForFieldName("name")?.text || "[anonymous arrow]");

      return [...funcNames, ...methodNames, ...arrowFunctionNames];
    });
  }

  public findFunctionAtPosition(
    sourceCode: string,
    position: number
  ): string | undefined {
    const tree = this.parser.parse(sourceCode);

    // Check function declarations
    let func = tree.rootNode
      .descendantsOfType("function_declaration")
      .find((f) => position >= f.startIndex && position <= f.endIndex);
    if (func) return func.childForFieldName("name")?.text || "[anonymous]";

    // Check method definitions
    func = tree.rootNode
      .descendantsOfType("method_definition")
      .find((f) => position >= f.startIndex && position <= f.endIndex);
    if (func)
      return func.childForFieldName("name")?.text || "[anonymous method]";

    // Check arrow functions
    const arrowFunc = tree.rootNode
      .descendantsOfType("variable_declarator")
      .find((v) => {
        const value = v.childForFieldName("value");
        return (
          position >= v.startIndex &&
          position <= v.endIndex &&
          value?.type === "arrow_function"
        );
      });
    return arrowFunc?.childForFieldName("name")?.text || "[anonymous arrow]";
  }

  /** Function-expression node types (may be anonymous or bound to a name). */
  private static readonly FUNCTION_EXPRESSION_TYPES = new Set([
    "arrow_function",
    "function",
    "function_expression",
    "generator_function",
  ]);

  /** Node types that are always their own named definition. */
  private static readonly NAMED_DEFINITION_TYPES = new Set([
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
  ]);

  /**
   * Extracts every named function/method/arrow-function definition in the
   * source along with the names of the functions it calls. Calls made inside a
   * nested *named* function are attributed to that function; calls inside
   * anonymous callbacks are attributed to the enclosing function. This is the
   * building block for cross-file call/usage graphs.
   */
  public extractFunctionsWithCalls(sourceCode: string): TsFunctionInfo[] {
    const tree = this.parser.parse(sourceCode);
    const results: TsFunctionInfo[] = [];

    const pushDef = (
      defNode: Parser.SyntaxNode,
      nameNode: Parser.SyntaxNode | null,
      bodyNode: Parser.SyntaxNode | null,
      kind: TsFunctionInfo["kind"]
    ) => {
      const name = nameNode?.text;
      if (!name) return;
      results.push({
        name,
        kind,
        startIndex: defNode.startIndex,
        endIndex: defNode.endIndex,
        startLine: defNode.startPosition.row,
        calls: this.collectCalleeNames(bodyNode),
      });
    };

    for (const f of tree.rootNode.descendantsOfType("function_declaration")) {
      pushDef(f, f.childForFieldName("name"), f.childForFieldName("body"), "function");
    }

    for (const m of tree.rootNode.descendantsOfType("method_definition")) {
      pushDef(m, m.childForFieldName("name"), m.childForFieldName("body"), "method");
    }

    // Arrow/function expressions bound to a variable (const fn = () => {}).
    for (const v of tree.rootNode.descendantsOfType("variable_declarator")) {
      const value = v.childForFieldName("value");
      if (value && TsAstParser.FUNCTION_EXPRESSION_TYPES.has(value.type)) {
        pushDef(v, v.childForFieldName("name"), value.childForFieldName("body"), "arrow");
      }
    }

    // Class field arrow functions (onClick = () => {}), common in React etc.
    for (const p of tree.rootNode.descendantsOfType("public_field_definition")) {
      const value = p.childForFieldName("value");
      if (value && TsAstParser.FUNCTION_EXPRESSION_TYPES.has(value.type)) {
        pushDef(p, p.childForFieldName("name"), value.childForFieldName("body"), "method");
      }
    }

    return results;
  }

  /**
   * Collects the distinct names of functions/methods invoked within a body.
   * Calls inside anonymous callbacks (e.g. `arr.map(x => foo(x))`) are
   * attributed to the enclosing function, but calls inside nested *named*
   * definitions are not (they are recorded against that definition instead).
   */
  private collectCalleeNames(body: Parser.SyntaxNode | null): string[] {
    const names = new Set<string>();
    if (!body) return [];

    const visit = (node: Parser.SyntaxNode) => {
      for (const child of node.namedChildren) {
        // Skip nested named definitions; their calls belong to them.
        if (this.isNamedDefinition(child)) {
          continue;
        }
        if (child.type === "call_expression") {
          const callee = this.calleeName(child.childForFieldName("function"));
          if (callee) names.add(callee);
        }
        visit(child);
      }
    };

    visit(body);
    return [...names];
  }

  /**
   * True when a node is a function that has its own definition entry: a
   * declaration/method, or a function expression bound to a name (variable or
   * class field). Anonymous function expressions return false so their calls
   * are attributed to the enclosing function.
   */
  private isNamedDefinition(node: Parser.SyntaxNode): boolean {
    if (TsAstParser.NAMED_DEFINITION_TYPES.has(node.type)) {
      return true;
    }
    if (TsAstParser.FUNCTION_EXPRESSION_TYPES.has(node.type)) {
      const parentType = node.parent?.type;
      return (
        parentType === "variable_declarator" ||
        parentType === "public_field_definition"
      );
    }
    return false;
  }

  /**
   * Resolves the simple name being called from a call expression's "function"
   * node (e.g. `foo()` -> "foo", `obj.bar()` / `this.bar()` -> "bar").
   */
  private calleeName(fn: Parser.SyntaxNode | null): string | undefined {
    if (!fn) return undefined;
    if (fn.type === "identifier") return fn.text;
    if (fn.type === "member_expression") {
      return fn.childForFieldName("property")?.text || undefined;
    }
    if (fn.type === "parenthesized_expression" && fn.namedChild(0)) {
      return this.calleeName(fn.namedChild(0));
    }
    return undefined;
  }

  public generateFlowchart(
    sourceCode: string,
    functionName?: string,
    position?: number
  ): FlowchartIR {
    const tree = this.parser.parse(sourceCode);
    this.resetState();

    let targetNode: Parser.SyntaxNode | undefined;
    let isArrowFunction = false;
    let isMethod = false;

    if (position !== undefined) {
      // Try to find function declaration at position
      targetNode = tree.rootNode
        .descendantsOfType("function_declaration")
        .find((f) => position >= f.startIndex && position <= f.endIndex);

      if (!targetNode) {
        // Try to find method definition at position
        targetNode = tree.rootNode
          .descendantsOfType("method_definition")
          .find((f) => position >= f.startIndex && position <= f.endIndex);
        isMethod = !!targetNode;
      }

      if (!targetNode) {
        // Try to find arrow function at position
        targetNode = tree.rootNode
          .descendantsOfType("variable_declarator")
          .find((v) => {
            const value = v.childForFieldName("value");
            return (
              position >= v.startIndex &&
              position <= v.endIndex &&
              value?.type === "arrow_function"
            );
          });
        isArrowFunction = !!targetNode;
      }
    } else if (functionName) {
      // Find by function name
      targetNode = tree.rootNode
        .descendantsOfType("function_declaration")
        .find((f) => f.childForFieldName("name")?.text === functionName);

      if (!targetNode) {
        targetNode = tree.rootNode
          .descendantsOfType("method_definition")
          .find((f) => f.childForFieldName("name")?.text === functionName);
        isMethod = !!targetNode;
      }

      if (!targetNode) {
        targetNode = tree.rootNode
          .descendantsOfType("variable_declarator")
          .find(
            (v) =>
              v.childForFieldName("name")?.text === functionName &&
              v.childForFieldName("value")?.type === "arrow_function"
          );
        isArrowFunction = !!targetNode;
      }
    } else {
      // Get first function
      targetNode =
        tree.rootNode.descendantsOfType("function_declaration")[0] ||
        tree.rootNode.descendantsOfType("method_definition")[0] ||
        tree.rootNode
          .descendantsOfType("variable_declarator")
          .find((v) => v.childForFieldName("value")?.type === "arrow_function");

      if (targetNode?.type === "method_definition") {
        isMethod = true;
      } else if (targetNode?.type === "variable_declarator") {
        isArrowFunction = true;
      }
    }

    if (!targetNode) {
      return {
        nodes: [
          {
            id: "A",
            label: "Place cursor inside a function to generate a flowchart.",
            shape: "rect",
            nodeType: NodeType.PROCESS,
          },
        ],
        edges: [],
        locationMap: [],
      };
    }

    this.currentFunctionIsArrow = isArrowFunction;

    // Get function body and name
    let bodyToProcess: Parser.SyntaxNode | null = null;
    let funcNameStr = "";

    if (isArrowFunction) {
      const arrowFunc = targetNode.childForFieldName("value");
      bodyToProcess = arrowFunc?.childForFieldName("body") || null;
      funcNameStr = this.escapeString(
        targetNode.childForFieldName("name")?.text || "[anonymous arrow]"
      );
    } else if (isMethod) {
      bodyToProcess = targetNode.childForFieldName("body");
      funcNameStr = this.escapeString(
        targetNode.childForFieldName("name")?.text || "[anonymous method]"
      );
    } else {
      bodyToProcess = targetNode.childForFieldName("body");
      funcNameStr = this.escapeString(
        targetNode.childForFieldName("name")?.text || "[anonymous function]"
      );
    }

    const title = `Flowchart for ${
      isArrowFunction ? "arrow function" : isMethod ? "method" : "function"
    }: ${funcNameStr}`;

    if (!bodyToProcess) {
      return {
        nodes: [
          this.createSemanticNode(
            "A",
            "Function has no body.",
            NodeType.PROCESS
          ),
        ],
        edges: [],
        locationMap: [],
      };
    }

    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    const entryId = this.generateNodeId("start");
    const exitId = this.generateNodeId("end");

    // Create semantic entry and exit nodes
    nodes.push(
      this.createSemanticNode(entryId, "Start", NodeType.ENTRY, targetNode)
    );
    nodes.push(
      this.createSemanticNode(exitId, "End", NodeType.EXIT, targetNode)
    );

    // For arrow functions with expression bodies, handle them differently
    const bodyResult =
      isArrowFunction && bodyToProcess.type !== "statement_block"
        ? this.processStatement(bodyToProcess, exitId)
        : this.processBlock(bodyToProcess, exitId);

    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);

    edges.push(
      bodyResult.entryNodeId
        ? { from: entryId, to: bodyResult.entryNodeId }
        : { from: entryId, to: exitId }
    );

    bodyResult.exitPoints.forEach((ep) => {
      if (!bodyResult.nodesConnectedToExit.has(ep.id)) {
        edges.push({ from: ep.id, to: exitId, label: ep.label });
      }
    });

    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const validEdges = edges.filter(
      (e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to)
    );

    const ir: FlowchartIR = {
      nodes,
      edges: validEdges,
      locationMap: this.locationMap,
      functionRange: { start: targetNode.startIndex, end: targetNode.endIndex },
      title,
      entryNodeId: entryId,
      exitNodeId: exitId,
    };


    return ir;
  }

  protected processStatement(
    statement: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    // Handle parenthesized expressions
    if (
      statement.type === "parenthesized_expression" &&
      statement.namedChild(0)
    ) {
      return this.processStatement(
        statement.namedChild(0)!,
        exitId,
        loopContext,
        finallyContext
      );
    }

    // Handle conditional expressions (ternary operator)
    if (statement.type === "conditional_expression") {
      return this.processConditionalExpression(
        statement,
        exitId,
        loopContext,
        finallyContext
      );
    }

    switch (statement.type) {
      case "if_statement":
        return this.processIfStatement(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      case "for_statement":
        return this.processForStatement(statement, exitId, finallyContext);
      case "for_in_statement":
        return this.processForInStatement(statement, exitId, finallyContext);
      case "while_statement":
        return this.processWhileStatement(statement, exitId, finallyContext);
      case "do_statement":
        return this.processDoWhileStatement(statement, exitId, finallyContext);
      case "try_statement":
        return this.processTryStatement(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      case "switch_statement":
        return this.processSwitchStatement(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      case "return_statement":
        return this.processReturnStatement(statement, exitId, finallyContext);
      case "throw_statement":
        return this.processThrowStatement(statement, exitId, finallyContext);
      case "break_statement":
        return loopContext
          ? this.processBreakStatement(statement, loopContext)
          : this.processDefaultStatement(statement);
      case "continue_statement":
        return loopContext
          ? this.processContinueStatement(statement, loopContext)
          : this.processDefaultStatement(statement);
      case "empty_statement":
        return this.createProcessResult();
      default: {
        // Handle variable declarations and assignments
        let expressionNode: Parser.SyntaxNode | undefined;
        let assignmentTargetNode: Parser.SyntaxNode | undefined;

        if (statement.type === "variable_declaration") {
          return this.processVariableDeclaration(
            statement,
            exitId,
            loopContext,
            finallyContext
          );
        } else if (statement.type === "assignment_expression") {
          expressionNode = statement.childForFieldName("right") ?? undefined;
          assignmentTargetNode =
            statement.childForFieldName("left") ?? undefined;
        } else if (statement.type === "expression_statement") {
          const child = statement.firstNamedChild;
          if (child?.type === "assignment_expression") {
            return this.processStatement(
              child,
              exitId,
              loopContext,
              finallyContext
            );
          }
          if (child?.type === "call_expression") {
            const nodeId = this.generateNodeId("call");
            const node: FlowchartNode = {
              id: nodeId,
              label: this.escapeString(child.text),
              shape: "rect",
              nodeType: NodeType.FUNCTION_CALL,
            };
            this.locationMap.push({
              start: child.startIndex,
              end: child.endIndex,
              nodeId,
            });
            return this.createProcessResult([node], [], nodeId, [
              { id: nodeId },
            ]);
          }
          expressionNode = child ?? undefined;
        }

        // Handle ternary expressions in assignments
        if (
          expressionNode?.type === "conditional_expression" &&
          assignmentTargetNode
        ) {
          const namedChildren = expressionNode.namedChildren;
          if (namedChildren.length < 3)
            return this.processDefaultStatement(statement);

          const targetText = this.escapeString(assignmentTargetNode.text);
          const [consequenceNode, conditionNode, alternativeNode] =
            namedChildren;
          const conditionId = this.generateNodeId("cond_expr");

          const nodes: FlowchartNode[] = [
            {
              id: conditionId,
              label: this.escapeString(conditionNode.text),
              shape: "diamond",
              nodeType: NodeType.DECISION,
            },
          ];
          const edges: FlowchartEdge[] = [];

          this.locationMap.push({
            start: conditionNode.startIndex,
            end: conditionNode.endIndex,
            nodeId: conditionId,
          });

          const consequenceId = this.generateNodeId("ternary_true");
          nodes.push({
            id: consequenceId,
            label: `${targetText} = ${this.escapeString(consequenceNode.text)}`,
            shape: "rect",
            nodeType: NodeType.ASSIGNMENT,
          });
          this.locationMap.push({
            start: statement.startIndex,
            end: statement.endIndex,
            nodeId: consequenceId,
          });
          edges.push({ from: conditionId, to: consequenceId, label: "true" });

          const alternativeId = this.generateNodeId("ternary_false");
          nodes.push({
            id: alternativeId,
            label: `${targetText} = ${this.escapeString(alternativeNode.text)}`,
            shape: "rect",
            nodeType: NodeType.ASSIGNMENT,
          });
          this.locationMap.push({
            start: statement.startIndex,
            end: statement.endIndex,
            nodeId: alternativeId,
          });
          edges.push({ from: conditionId, to: alternativeId, label: "false" });

          return this.createProcessResult(nodes, edges, conditionId, [
            { id: consequenceId },
            { id: alternativeId },
          ]);
        }

        // For arrow functions, treat expressions as return statements
        return this.currentFunctionIsArrow
          ? this.processReturnStatementForExpression(
              statement,
              exitId,
              finallyContext
            )
          : this.processDefaultStatement(statement);
      }
    }
  }

  // --- PRIVATE HELPER AND PROCESSING METHODS --- //

  private processConditionalExpression(
    condExprNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const namedChildren = condExprNode.namedChildren;
    if (namedChildren.length < 3)
      return this.processDefaultStatement(condExprNode);

    const [consequenceNode, conditionNode, alternativeNode] = namedChildren;
    const conditionId = this.generateNodeId("cond_expr");
    const nodes: FlowchartNode[] = [
      {
        id: conditionId,
        label: this.escapeString(conditionNode.text),
        shape: "diamond",
        nodeType: NodeType.DECISION,
      },
    ];
    this.locationMap.push({
      start: conditionNode.startIndex,
      end: conditionNode.endIndex,
      nodeId: conditionId,
    });

    const consequenceResult = this.processStatement(
      consequenceNode,
      exitId,
      loopContext,
      finallyContext
    );
    const alternativeResult = this.processStatement(
      alternativeNode,
      exitId,
      loopContext,
      finallyContext
    );

    nodes.push(...consequenceResult.nodes, ...alternativeResult.nodes);
    const edges: FlowchartEdge[] = [
      ...consequenceResult.edges,
      ...alternativeResult.edges,
    ];
    const nodesConnectedToExit = new Set<string>([
      ...consequenceResult.nodesConnectedToExit,
      ...alternativeResult.nodesConnectedToExit,
    ]);

    if (consequenceResult.entryNodeId) {
      edges.push({
        from: conditionId,
        to: consequenceResult.entryNodeId,
        label: "true",
      });
    }
    if (alternativeResult.entryNodeId) {
      edges.push({
        from: conditionId,
        to: alternativeResult.entryNodeId,
        label: "false",
      });
    }

    return this.createProcessResult(
      nodes,
      edges,
      conditionId,
      this.currentFunctionIsArrow
        ? []
        : [...consequenceResult.exitPoints, ...alternativeResult.exitPoints],
      nodesConnectedToExit
    );
  }

  private processIfStatement(
    ifNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const ifConditionNode = ifNode.childForFieldName("condition");
    const ifConsequenceNode = ifNode.childForFieldName("consequence");
    if (!ifConditionNode || !ifConsequenceNode)
      return this.createProcessResult();

    const ifConditionId = this.generateNodeId("cond");
    const nodes: FlowchartNode[] = [
      {
        id: ifConditionId,
        label: this.escapeString(ifConditionNode.text),
        shape: "diamond",
        nodeType: NodeType.DECISION,
      },
    ];
    this.locationMap.push({
      start: ifConditionNode.startIndex,
      end: ifConditionNode.endIndex,
      nodeId: ifConditionId,
    });

    const ifConsequenceResult = this.processBlock(
      ifConsequenceNode,
      exitId,
      loopContext,
      finallyContext
    );
    nodes.push(...ifConsequenceResult.nodes);
    const edges: FlowchartEdge[] = [...ifConsequenceResult.edges];
    const nodesConnectedToExit = new Set<string>(
      ifConsequenceResult.nodesConnectedToExit
    );
    const allExitPoints: { id: string; label?: string }[] = [
      ...ifConsequenceResult.exitPoints,
    ];

    if (ifConsequenceResult.entryNodeId) {
      edges.push({
        from: ifConditionId,
        to: ifConsequenceResult.entryNodeId,
        label: "true",
      });
    } else {
      allExitPoints.push({ id: ifConditionId, label: "true" });
    }

    // Handle else clause
    const elseClause = ifNode.childForFieldName("alternative");
    if (elseClause) {
      const elseResult = this.processBlock(
        elseClause,
        exitId,
        loopContext,
        finallyContext
      );
      nodes.push(...elseResult.nodes);
      edges.push(...elseResult.edges);
      elseResult.nodesConnectedToExit.forEach((n) =>
        nodesConnectedToExit.add(n)
      );

      if (elseResult.entryNodeId) {
        edges.push({
          from: ifConditionId,
          to: elseResult.entryNodeId,
          label: "false",
        });
      } else {
        allExitPoints.push({ id: ifConditionId, label: "false" });
      }
      allExitPoints.push(...elseResult.exitPoints);
    } else {
      allExitPoints.push({ id: ifConditionId, label: "false" });
    }

    return this.createProcessResult(
      nodes,
      edges,
      ifConditionId,
      allExitPoints,
      nodesConnectedToExit
    );
  }

  private processForStatement(
    forNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const initNode = forNode.childForFieldName("init");
    const conditionNode = forNode.childForFieldName("condition");
    const updateNode = forNode.childForFieldName("update");
    const bodyNode = forNode.childForFieldName("body");

    if (!bodyNode) {
      return this.createProcessResult();
    }

    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    let entryPointId: string | undefined;
    let lastProcessedId: string | undefined;

    // 1. Initializer Node
    if (initNode) {
      const initId = this.generateNodeId("for_init");
      nodes.push({
        id: initId,
        label: this.escapeString(initNode.text),
        shape: "rect",
        nodeType: NodeType.PROCESS,
      });
      this.locationMap.push({
        start: initNode.startIndex,
        end: initNode.endIndex,
        nodeId: initId,
      });
      entryPointId = initId;
      lastProcessedId = initId;
    }

    // 2. Condition Node
    const conditionId = this.generateNodeId("for_cond");
    nodes.push({
      id: conditionId,
      label: this.escapeString(conditionNode?.text || "true"),
      shape: "diamond",
      nodeType: NodeType.DECISION,
    });
    if (conditionNode) {
      this.locationMap.push({
        start: conditionNode.startIndex,
        end: conditionNode.endIndex,
        nodeId: conditionId,
      });
    }

    if (lastProcessedId) {
      edges.push({ from: lastProcessedId, to: conditionId });
    } else {
      entryPointId = conditionId;
    }

    // 3. Update Node
    let updateId: string | undefined;
    if (updateNode) {
      updateId = this.generateNodeId("for_update");
      nodes.push({
        id: updateId,
        label: this.escapeString(updateNode.text),
        shape: "rect",
        nodeType: NodeType.PROCESS,
      });
      this.locationMap.push({
        start: updateNode.startIndex,
        end: updateNode.endIndex,
        nodeId: updateId,
      });
      // Connect update back to condition
      edges.push({ from: updateId, to: conditionId });
    }

    // Add the loop exit node
    const loopExitId = this.generateNodeId("for_exit");
    nodes.push({
      id: loopExitId,
      label: "end for",
      shape: "stadium",
      nodeType: NodeType.LOOP_END,
    });

    // Loop Context for break/continue
    const continueTargetId = updateId || conditionId;
    const loopContext: LoopContext = {
      breakTargetId: loopExitId,
      continueTargetId: continueTargetId,
    };

    // 4. Loop Body
    const bodyResult = this.processBlock(
      bodyNode,
      exitId,
      loopContext,
      finallyContext
    );
    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);
    bodyResult.nodesConnectedToExit.forEach((n) => nodesConnectedToExit.add(n));

    // 5. Connect the parts
    if (bodyResult.entryNodeId) {
      // Condition (true) -> Body
      edges.push({
        from: conditionId,
        to: bodyResult.entryNodeId,
        label: "true",
      });

      // Body -> Update (or Condition)
      bodyResult.exitPoints.forEach((ep) => {
        edges.push({ from: ep.id, to: continueTargetId });
      });
    } else {
      // Empty loop body, loop goes from condition straight to update
      edges.push({ from: conditionId, to: continueTargetId, label: "true" });
    }

    // Condition (false) -> Exit
    edges.push({ from: conditionId, to: loopExitId, label: "false" });

    // The exit point for the whole for-loop construct is the loopExitId
    return this.createProcessResult(
      nodes,
      edges,
      entryPointId,
      [{ id: loopExitId }],
      nodesConnectedToExit
    );
  }

  private processForInStatement(
    forInNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const left = forInNode.childForFieldName("left");
    const right = forInNode.childForFieldName("right");
    const headerText = `for (${left?.text || ""} in ${right?.text || ""})`;
    const headerId = this.generateNodeId("for_in_header");
    const loopExitId = this.generateNodeId("for_in_exit");

    const nodes: FlowchartNode[] = [
      {
        id: headerId,
        label: this.escapeString(headerText),
        shape: "diamond",
        nodeType: NodeType.DECISION,
      },
      {
        id: loopExitId,
        label: "end loop",
        shape: "stadium",
        nodeType: NodeType.LOOP_END,
      },
    ];
    this.locationMap.push({
      start: forInNode.startIndex,
      end: forInNode.endIndex,
      nodeId: headerId,
    });

    const loopContext: LoopContext = {
      breakTargetId: loopExitId,
      continueTargetId: headerId,
    };
    const bodyResult = this.processBlock(
      forInNode.childForFieldName("body")!,
      exitId,
      loopContext,
      finallyContext
    );
    nodes.push(...bodyResult.nodes);
    const edges: FlowchartEdge[] = [...bodyResult.edges];

    if (bodyResult.entryNodeId) {
      edges.push({
        from: headerId,
        to: bodyResult.entryNodeId,
        label: "next item",
      });
    } else {
      edges.push({ from: headerId, to: headerId, label: "next item" });
    }

    bodyResult.exitPoints.forEach((ep) =>
      edges.push({ from: ep.id, to: headerId })
    );
    edges.push({ from: headerId, to: loopExitId, label: "no more items" });

    return this.createProcessResult(
      nodes,
      edges,
      headerId,
      [{ id: loopExitId }],
      bodyResult.nodesConnectedToExit
    );
  }

  private processWhileStatement(
    whileNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const conditionText = this.escapeString(
      whileNode.childForFieldName("condition")!.text
    );
    const conditionId = this.generateNodeId("while_cond");
    const loopExitId = this.generateNodeId("while_exit");

    const nodes: FlowchartNode[] = [
      {
        id: conditionId,
        label: conditionText,
        shape: "diamond",
        nodeType: NodeType.DECISION,
      },
      {
        id: loopExitId,
        label: "end loop",
        shape: "stadium",
        nodeType: NodeType.LOOP_END,
      },
    ];
    this.locationMap.push({
      start: whileNode.startIndex,
      end: whileNode.endIndex,
      nodeId: conditionId,
    });

    const loopContext: LoopContext = {
      breakTargetId: loopExitId,
      continueTargetId: conditionId,
    };
    const bodyResult = this.processBlock(
      whileNode.childForFieldName("body")!,
      exitId,
      loopContext,
      finallyContext
    );
    nodes.push(...bodyResult.nodes);
    const edges: FlowchartEdge[] = [...bodyResult.edges];

    if (bodyResult.entryNodeId) {
      edges.push({
        from: conditionId,
        to: bodyResult.entryNodeId,
        label: "true",
      });
    } else {
      edges.push({ from: conditionId, to: conditionId, label: "true" });
    }

    bodyResult.exitPoints.forEach((ep) =>
      edges.push({ from: ep.id, to: conditionId })
    );
    edges.push({ from: conditionId, to: loopExitId, label: "false" });

    return this.createProcessResult(
      nodes,
      edges,
      conditionId,
      [{ id: loopExitId }],
      bodyResult.nodesConnectedToExit
    );
  }

  private processDoWhileStatement(
    doWhileNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const conditionNode = doWhileNode.childForFieldName("condition");
    const conditionText = this.escapeString(conditionNode?.text || "condition");
    const conditionId = this.generateNodeId("do_while_cond");
    const loopExitId = this.generateNodeId("do_while_exit");

    const nodes: FlowchartNode[] = [
      {
        id: conditionId,
        label: conditionText,
        shape: "diamond",
        nodeType: NodeType.DECISION,
      },
      {
        id: loopExitId,
        label: "end loop",
        shape: "stadium",
        nodeType: NodeType.LOOP_END,
      },
    ];
    this.locationMap.push({
      start: doWhileNode.startIndex,
      end: doWhileNode.endIndex,
      nodeId: conditionId,
    });

    const loopContext: LoopContext = {
      breakTargetId: loopExitId,
      continueTargetId: conditionId,
    };
    const bodyResult = this.processBlock(
      doWhileNode.childForFieldName("body")!,
      exitId,
      loopContext,
      finallyContext
    );
    nodes.push(...bodyResult.nodes);
    const edges: FlowchartEdge[] = [...bodyResult.edges];

    // In do-while, body executes first, then condition
    bodyResult.exitPoints.forEach((ep) =>
      edges.push({ from: ep.id, to: conditionId })
    );
    edges.push({
      from: conditionId,
      to: bodyResult.entryNodeId || conditionId,
      label: "true",
    });
    edges.push({ from: conditionId, to: loopExitId, label: "false" });

    return this.createProcessResult(
      nodes,
      edges,
      bodyResult.entryNodeId,
      [{ id: loopExitId }],
      bodyResult.nodesConnectedToExit
    );
  }

  private processSwitchStatement(
    switchNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const discriminantNode = switchNode.childForFieldName("value");
    if (!discriminantNode) return this.processDefaultStatement(switchNode);

    const switchId = this.generateNodeId("switch");
    const nodes: FlowchartNode[] = [
      {
        id: switchId,
        label: `switch (${this.escapeString(discriminantNode.text)})`,
        shape: "rect",
        nodeType: NodeType.DECISION,
      },
    ];
    this.locationMap.push({
      start: discriminantNode.startIndex,
      end: discriminantNode.endIndex,
      nodeId: switchId,
    });

    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    const allExitPoints: { id: string; label?: string }[] = [];

    const body = switchNode.childForFieldName("body");
    const cases =
      body?.namedChildren.filter(
        (child) =>
          child.type === "switch_case" || child.type === "switch_default"
      ) || [];

    let lastCaseExitPoints: { id: string; label?: string }[] = [
      { id: switchId },
    ];

    for (const caseNode of cases) {
      const isDefault = caseNode.type === "switch_default";
      const valueNode = caseNode.childForFieldName("value");
      const caseLabel = isDefault
        ? "default"
        : `case ${this.escapeString(valueNode?.text || "")}`;

      const caseId = this.generateNodeId("case");
      nodes.push({
        id: caseId,
        label: caseLabel,
        shape: "diamond",
        nodeType: NodeType.DECISION,
      });
      this.locationMap.push({
        start: caseNode.startIndex,
        end: caseNode.endIndex,
        nodeId: caseId,
      });

      // Connect from previous case or switch
      lastCaseExitPoints.forEach((ep) => {
        edges.push({ from: ep.id, to: caseId, label: ep.label || "no match" });
      });

      // Process case body
      const caseBody = caseNode.namedChildren.filter(
        (child) =>
          child.type !== "switch_case" && child.type !== "switch_default"
      );

      if (caseBody.length > 0) {
        let caseExitPoints: { id: string; label?: string }[] = [
          { id: caseId, label: "match" },
        ];

        for (const stmt of caseBody) {
          const stmtResult = this.processStatement(
            stmt,
            exitId,
            loopContext,
            finallyContext
          );
          nodes.push(...stmtResult.nodes);
          edges.push(...stmtResult.edges);
          stmtResult.nodesConnectedToExit.forEach((n) =>
            nodesConnectedToExit.add(n)
          );

          if (stmtResult.entryNodeId) {
            caseExitPoints.forEach((ep) => {
              edges.push({
                from: ep.id,
                to: stmtResult.entryNodeId!,
                label: ep.label,
              });
            });
            caseExitPoints = stmtResult.exitPoints;
          }
        }

        allExitPoints.push(...caseExitPoints);
        lastCaseExitPoints = [{ id: caseId, label: "no match" }];
      } else {
        lastCaseExitPoints = [{ id: caseId, label: "no match" }];
        allExitPoints.push({ id: caseId, label: "match" });
      }
    }

    // Handle cases with no match
    allExitPoints.push(...lastCaseExitPoints);

    return this.createProcessResult(
      nodes,
      edges,
      switchId,
      allExitPoints,
      nodesConnectedToExit
    );
  }

  private processTryStatement(
    tryNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const entryId = this.generateNodeId("try_entry");
    const nodes: FlowchartNode[] = [
      {
        id: entryId,
        label: "try",
        shape: "stadium",
        nodeType: NodeType.PROCESS,
      },
    ];
    this.locationMap.push({
      start: tryNode.startIndex,
      end: tryNode.endIndex,
      nodeId: entryId,
    });

    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    let allExitPoints: { id: string; label?: string }[] = [];

    // Process finally clause first to create context
    let newFinallyContext: { finallyEntryId: string } | undefined;
    let finallyResult: ProcessResult | null = null;
    const finallyClause = tryNode.childForFieldName("finalizer");

    if (finallyClause) {
      finallyResult = this.processBlock(
        finallyClause,
        exitId,
        loopContext,
        finallyContext
      );
      if (finallyResult.entryNodeId) {
        nodes.push(...finallyResult.nodes);
        edges.push(...finallyResult.edges);
        finallyResult.nodesConnectedToExit.forEach((n) =>
          nodesConnectedToExit.add(n)
        );
        newFinallyContext = { finallyEntryId: finallyResult.entryNodeId };
      }
    }

    // Process try body
    const tryBody = tryNode.childForFieldName("body");
    const tryResult = this.processBlock(
      tryBody!,
      exitId,
      loopContext,
      newFinallyContext || finallyContext
    );
    nodes.push(...tryResult.nodes);
    edges.push(...tryResult.edges);
    tryResult.nodesConnectedToExit.forEach((n) => nodesConnectedToExit.add(n));

    if (tryResult.entryNodeId) {
      edges.push({ from: entryId, to: tryResult.entryNodeId });
    } else if (finallyResult?.entryNodeId) {
      edges.push({ from: entryId, to: finallyResult.entryNodeId });
    } else {
      allExitPoints.push({ id: entryId });
    }

    tryResult.exitPoints.forEach((ep) => {
      if (finallyResult?.entryNodeId) {
        edges.push({
          from: ep.id,
          to: finallyResult.entryNodeId,
          label: ep.label,
        });
      } else {
        allExitPoints.push(ep);
      }
    });

    // Process catch clauses
    const handler = tryNode.childForFieldName("handler");
    if (handler) {
      const parameter = handler.childForFieldName("parameter");
      const catchType = parameter ? this.escapeString(parameter.text) : "error";

      const catchResult = this.processBlock(
        handler.childForFieldName("body")!,
        exitId,
        loopContext,
        newFinallyContext || finallyContext
      );
      nodes.push(...catchResult.nodes);
      edges.push(...catchResult.edges);
      catchResult.nodesConnectedToExit.forEach((n) =>
        nodesConnectedToExit.add(n)
      );

      if (catchResult.entryNodeId) {
        edges.push({
          from: entryId,
          to: catchResult.entryNodeId,
          label: `catch ${catchType}`,
        });
        catchResult.exitPoints.forEach((ep) => {
          if (finallyResult?.entryNodeId) {
            edges.push({
              from: ep.id,
              to: finallyResult.entryNodeId,
              label: ep.label,
            });
          } else {
            allExitPoints.push(ep);
          }
        });
      }
    }

    if (finallyResult) allExitPoints.push(...finallyResult.exitPoints);

    return this.createProcessResult(
      nodes,
      edges,
      entryId,
      allExitPoints,
      nodesConnectedToExit
    );
  }

  private processReturnStatement(
    returnNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const valueNode = returnNode.namedChild(0);
    const nodeId = this.generateNodeId("return");
    const labelText = valueNode
      ? `return ${this.escapeString(valueNode.text)}`
      : "return";
    const node: FlowchartNode = {
      id: nodeId,
      label: labelText,
      shape: "stadium",
      nodeType: NodeType.RETURN,
    };
    const edges: FlowchartEdge[] = [
      {
        from: nodeId,
        to: finallyContext ? finallyContext.finallyEntryId : exitId,
      },
    ];
    this.locationMap.push({
      start: returnNode.startIndex,
      end: returnNode.endIndex,
      nodeId,
    });
    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processThrowStatement(
    throwNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const valueNode = throwNode.namedChild(0);
    const nodeId = this.generateNodeId("throw");
    const labelText = valueNode
      ? `throw ${this.escapeString(valueNode.text)}`
      : "throw";
    const node: FlowchartNode = {
      id: nodeId,
      label: labelText,
      shape: "stadium",
      nodeType: NodeType.EXCEPTION,
    };
    const edges: FlowchartEdge[] = [
      {
        from: nodeId,
        to: finallyContext ? finallyContext.finallyEntryId : exitId,
      },
    ];
    this.locationMap.push({
      start: throwNode.startIndex,
      end: throwNode.endIndex,
      nodeId,
    });
    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processBreakStatement(
    breakNode: Parser.SyntaxNode,
    loopContext: LoopContext
  ): ProcessResult {
    const nodeId = this.generateNodeId("break");
    const node: FlowchartNode = {
      id: nodeId,
      label: "break",
      shape: "stadium",
      nodeType: NodeType.BREAK_CONTINUE,
    };
    const edges: FlowchartEdge[] = [
      { from: nodeId, to: loopContext.breakTargetId },
    ];
    this.locationMap.push({
      start: breakNode.startIndex,
      end: breakNode.endIndex,
      nodeId,
    });
    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processContinueStatement(
    continueNode: Parser.SyntaxNode,
    loopContext: LoopContext
  ): ProcessResult {
    const nodeId = this.generateNodeId("continue");
    const node: FlowchartNode = {
      id: nodeId,
      label: "continue",
      shape: "stadium",
      nodeType: NodeType.BREAK_CONTINUE,
    };
    const edges: FlowchartEdge[] = [
      { from: nodeId, to: loopContext.continueTargetId },
    ];
    this.locationMap.push({
      start: continueNode.startIndex,
      end: continueNode.endIndex,
      nodeId,
    });
    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processVariableDeclaration(
    declNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const declarators = declNode.namedChildren.filter(
      (child) => child.type === "variable_declarator"
    );

    if (declarators.length === 0) {
      return this.processDefaultStatement(declNode);
    }

    // For single declarator, process it directly
    if (declarators.length === 1) {
      const declarator = declarators[0];
      const name = declarator.childForFieldName("name");
      const value = declarator.childForFieldName("value");

      if (value?.type === "conditional_expression") {
        return this.processStatement(
          declNode,
          exitId,
          loopContext,
          finallyContext
        );
      }

      const nodeId = this.generateNodeId("var_decl");
      const labelText = `${declNode.childForFieldName("kind")?.text || "var"} ${
        name?.text || "variable"
      }${value ? ` = ${this.escapeString(value.text)}` : ""}`;
      const node: FlowchartNode = {
        id: nodeId,
        label: labelText,
        shape: "rect",
        nodeType: NodeType.ASSIGNMENT,
      };
      this.locationMap.push({
        start: declNode.startIndex,
        end: declNode.endIndex,
        nodeId,
      });
      return this.createProcessResult([node], [], nodeId, [{ id: nodeId }]);
    }

    // For multiple declarators, create separate nodes
    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    let entryNodeId: string | undefined;
    let lastNodeId: string | undefined;

    for (const declarator of declarators) {
      const name = declarator.childForFieldName("name");
      const value = declarator.childForFieldName("value");

      const nodeId = this.generateNodeId("var_decl");
      const labelText = `${declNode.childForFieldName("kind")?.text || "var"} ${
        name?.text || "variable"
      }${value ? ` = ${this.escapeString(value.text)}` : ""}`;
      const node: FlowchartNode = {
        id: nodeId,
        label: labelText,
        shape: "rect",
        nodeType: NodeType.ASSIGNMENT,
      };
      nodes.push(node);
      this.locationMap.push({
        start: declarator.startIndex,
        end: declarator.endIndex,
        nodeId,
      });

      if (!entryNodeId) entryNodeId = nodeId;
      if (lastNodeId) {
        edges.push({ from: lastNodeId, to: nodeId });
      }
      lastNodeId = nodeId;
    }

    return this.createProcessResult(
      nodes,
      edges,
      entryNodeId,
      lastNodeId ? [{ id: lastNodeId }] : []
    );
  }

  private processReturnStatementForExpression(
    exprNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const nodeId = this.generateNodeId("return");
    const labelText = `return ${this.escapeString(exprNode.text)}`;
    const node: FlowchartNode = {
      id: nodeId,
      label: labelText,
      shape: "stadium",
      nodeType: NodeType.RETURN,
    };
    const edges: FlowchartEdge[] = [
      {
        from: nodeId,
        to: finallyContext ? finallyContext.finallyEntryId : exitId,
      },
    ];
    this.locationMap.push({
      start: exprNode.startIndex,
      end: exprNode.endIndex,
      nodeId,
    });
    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }
}
