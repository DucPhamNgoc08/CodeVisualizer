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

export class PhpAstParser extends AbstractParser {
  private currentFunctionIsExpressionBody = false;

  private constructor(parser: Parser) {
    super(parser, "php");
  }

  public static async create(wasmPath: string): Promise<PhpAstParser> {
    await ensureParserInit();
    const language = await Parser.Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(language);
    return new PhpAstParser(parser);
  }

  public listFunctions(sourceCode: string): string[] {
    return this.measurePerformance("listFunctions", () => {
      const tree = this.parser.parse(sourceCode);

      const functions = tree.rootNode
        .descendantsOfType(["function_definition", "method_declaration"])
        .map((node) => this.extractFunctionName(node) || "[anonymous]");

      const anonymousFunctions = tree.rootNode
        .descendantsOfType("assignment_expression")
        .filter((node) => {
          const right = node.childForFieldName("right");
          return right?.type === "anonymous_function" || right?.type === "arrow_function";
        })
        .map((node) => this.extractAssignedFunctionName(node) || "[anonymous]");

      return [...functions, ...anonymousFunctions];
    });
  }

  public findFunctionAtPosition(
    sourceCode: string,
    position: number
  ): string | undefined {
    const tree = this.parser.parse(sourceCode);
    const target = this.findTargetNode(tree.rootNode, position);
    if (!target) {
      return undefined;
    }

    if (target.type === "assignment_expression") {
      return this.extractAssignedFunctionName(target) || "[anonymous]";
    }

    return this.extractFunctionName(target) || "[anonymous]";
  }

  public generateFlowchart(
    sourceCode: string,
    functionName?: string,
    position?: number
  ): FlowchartIR {
    const tree = this.parser.parse(sourceCode);
    this.resetState();

    let targetNode: Parser.SyntaxNode | undefined;
    if (position !== undefined) {
      targetNode = this.findTargetNode(tree.rootNode, position);
    } else if (functionName) {
      targetNode = this.findTargetNodeByName(tree.rootNode, functionName);
    } else {
      targetNode =
        tree.rootNode.descendantsOfType("function_definition")[0] ||
        tree.rootNode.descendantsOfType("method_declaration")[0] ||
        this.findAssignedFunction(tree.rootNode);
    }

    if (!targetNode) {
      return {
        nodes: [
          this.createSemanticNode(
            "msg",
            "Place cursor inside a PHP function or method.",
            NodeType.PROCESS
          ),
        ],
        edges: [],
        locationMap: [],
      };
    }

    const body = this.getFunctionBody(targetNode);
    const functionNameText = this.getDisplayName(targetNode);
    const functionKind = this.getFunctionKind(targetNode);
    const title = `Flowchart for ${functionKind}: ${this.escapeString(functionNameText)}`;

    if (!body) {
      return {
        nodes: [
          this.createSemanticNode(
            "msg",
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
    const previousExpressionBody = this.currentFunctionIsExpressionBody;
    this.currentFunctionIsExpressionBody = body.type !== "compound_statement";

    nodes.push(this.createSemanticNode(entryId, "Start", NodeType.ENTRY, targetNode));
    nodes.push(this.createSemanticNode(exitId, "End", NodeType.EXIT, targetNode));
    this.locationMap.push({
      start: targetNode.startIndex,
      end: targetNode.endIndex,
      nodeId: entryId,
    });
    this.locationMap.push({
      start: targetNode.startIndex,
      end: targetNode.endIndex,
      nodeId: exitId,
    });

    const bodyResult =
      body.type === "compound_statement"
        ? this.processBlock(body, exitId)
        : this.processReturnStatementForExpression(body, exitId);

    this.currentFunctionIsExpressionBody = previousExpressionBody;

    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);
    edges.push(
      bodyResult.entryNodeId
        ? { from: entryId, to: bodyResult.entryNodeId }
        : { from: entryId, to: exitId }
    );

    bodyResult.exitPoints.forEach((exitPoint) => {
      if (!bodyResult.nodesConnectedToExit.has(exitPoint.id)) {
        edges.push({ from: exitPoint.id, to: exitId, label: exitPoint.label });
      }
    });

    const nodeIds = new Set(nodes.map((node) => node.id));
    const validEdges = edges.filter(
      (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)
    );
    const validLocationMap = this.locationMap.filter((entry) =>
      nodeIds.has(entry.nodeId)
    );

    return {
      nodes,
      edges: validEdges,
      entryNodeId: entryId,
      exitNodeId: exitId,
      locationMap: validLocationMap,
      functionRange: { start: targetNode.startIndex, end: targetNode.endIndex },
      title,
    };
  }

  protected processBlock(
    blockNode: Parser.SyntaxNode | null,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    if (!blockNode) {
      return this.createProcessResult();
    }

    const statements = blockNode.namedChildren.filter(
      (child) =>
        ![
          "comment",
          "text",
          "php_tag",
          "namespace_definition",
          "namespace_use_declaration",
        ].includes(child.type)
    );

    return this.processStatementList(statements, exitId, loopContext, finallyContext);
  }

  protected processStatement(
    statement: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
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

    switch (statement.type) {
      case "if_statement":
        return this.processIfStatement(statement, exitId, loopContext, finallyContext);
      case "for_statement":
        return this.processForStatement(statement, exitId, finallyContext);
      case "foreach_statement":
        return this.processForeachStatement(statement, exitId, finallyContext);
      case "while_statement":
        return this.processWhileStatement(statement, exitId, finallyContext);
      case "do_statement":
        return this.processDoStatement(statement, exitId, finallyContext);
      case "switch_statement":
        return this.processSwitchStatement(statement, exitId, loopContext, finallyContext);
      case "try_statement":
        return this.processTryStatement(statement, exitId, loopContext, finallyContext);
      case "return_statement":
        return this.processReturnStatement(statement, exitId, finallyContext);
      case "throw_expression":
        return this.processThrow(statement, exitId, finallyContext);
      case "break_statement":
        return loopContext
          ? this.processBreakStatement(statement, loopContext)
          : this.processDefaultStatement(statement);
      case "continue_statement":
        return loopContext
          ? this.processContinueStatement(statement, loopContext)
          : this.processDefaultStatement(statement);
      case "echo_statement":
        return this.processProcessLike(statement, NodeType.PROCESS, "echo");
      case "expression_statement":
        return this.processExpressionStatement(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      case "compound_statement":
        return this.processBlock(statement, exitId, loopContext, finallyContext);
      default:
        return this.currentFunctionIsExpressionBody
          ? this.processReturnStatementForExpression(statement, exitId, finallyContext)
          : this.processDefaultStatement(statement);
    }
  }

  private processStatementList(
    statements: Parser.SyntaxNode[],
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    if (statements.length === 0) {
      return this.createProcessResult();
    }

    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    let entryNodeId: string | undefined;
    let lastExitPoints: { id: string; label?: string }[] = [];

    for (const statement of statements) {
      const result = this.processStatement(
        statement,
        exitId,
        loopContext,
        finallyContext
      );

      if (result.nodes.length === 0 && !result.entryNodeId) {
        continue;
      }

      nodes.push(...result.nodes);
      edges.push(...result.edges);
      result.nodesConnectedToExit.forEach((nodeId) =>
        nodesConnectedToExit.add(nodeId)
      );

      if (!entryNodeId) {
        entryNodeId = result.entryNodeId;
      }

      if (lastExitPoints.length > 0 && result.entryNodeId) {
        lastExitPoints.forEach((exitPoint) => {
          edges.push({
            from: exitPoint.id,
            to: result.entryNodeId!,
            label: exitPoint.label,
          });
        });
      }

      lastExitPoints = result.exitPoints;
      if (result.entryNodeId && lastExitPoints.length === 0) {
        break;
      }
    }

    return this.createProcessResult(
      nodes,
      edges,
      entryNodeId,
      lastExitPoints,
      nodesConnectedToExit
    );
  }

  private processExpressionStatement(
    statement: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const expression = statement.firstNamedChild;
    if (!expression) {
      return this.createProcessResult();
    }

    if (expression.type === "assignment_expression") {
      return this.processAssignment(expression);
    }

    if (expression.type === "function_call_expression") {
      return this.processProcessLike(expression, NodeType.FUNCTION_CALL);
    }

    if (expression.type === "throw_expression") {
      return this.processThrow(expression, exitId, finallyContext);
    }

    if (
      expression.type === "require_expression" ||
      expression.type === "require_once_expression" ||
      expression.type === "include_expression" ||
      expression.type === "include_once_expression"
    ) {
      return this.processProcessLike(expression, NodeType.FUNCTION_CALL);
    }

    return this.currentFunctionIsExpressionBody
      ? this.processReturnStatementForExpression(statement, exitId, finallyContext)
      : this.processDefaultStatement(statement);
  }

  private processIfStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const condition = node.childForFieldName("condition");
    const body = node.childForFieldName("body");
    const decisionId = this.generateNodeId("if");
    const nodes: FlowchartNode[] = [
      this.createSemanticNode(
        decisionId,
        condition ? this.summarizeCondition(condition) : "if",
        NodeType.DECISION,
        condition || node
      ),
    ];
    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    const exitPoints: { id: string; label?: string }[] = [];

    this.locationMap.push({
      start: node.startIndex,
      end: node.endIndex,
      nodeId: decisionId,
    });

    const bodyResult = this.processStatementOrBlock(
      body,
      exitId,
      loopContext,
      finallyContext
    );
    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);
    bodyResult.nodesConnectedToExit.forEach((id) =>
      nodesConnectedToExit.add(id)
    );

    if (bodyResult.entryNodeId) {
      edges.push({ from: decisionId, to: bodyResult.entryNodeId, label: "true" });
    } else {
      exitPoints.push({ id: decisionId, label: "true" });
    }
    exitPoints.push(...bodyResult.exitPoints);

    const alternative = node.childForFieldName("alternative");
    if (alternative) {
      const altResult = this.processAlternativeClause(
        alternative,
        exitId,
        loopContext,
        finallyContext
      );
      nodes.push(...altResult.nodes);
      edges.push(...altResult.edges);
      altResult.nodesConnectedToExit.forEach((id) =>
        nodesConnectedToExit.add(id)
      );

      if (altResult.entryNodeId) {
        edges.push({
          from: decisionId,
          to: altResult.entryNodeId,
          label: "false",
        });
      } else {
        exitPoints.push({ id: decisionId, label: "false" });
      }
      exitPoints.push(...altResult.exitPoints);
    } else {
      exitPoints.push({ id: decisionId, label: "false" });
    }

    return this.createProcessResult(
      nodes,
      edges,
      decisionId,
      exitPoints,
      nodesConnectedToExit
    );
  }

  private processAlternativeClause(
    node: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    if (node.type === "else_if_clause") {
      return this.processElseIfClause(node, exitId, loopContext, finallyContext);
    }

    return this.processStatementOrBlock(
      node.childForFieldName("body") || node.firstNamedChild,
      exitId,
      loopContext,
      finallyContext
    );
  }

  private processElseIfClause(
    node: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const condition = node.childForFieldName("condition");
    const body = node.childForFieldName("body");
    const decisionId = this.generateNodeId("elseif");
    const nodes: FlowchartNode[] = [
      this.createSemanticNode(
        decisionId,
        condition ? this.summarizeCondition(condition) : "elseif",
        NodeType.DECISION,
        condition || node
      ),
    ];
    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    const exitPoints: { id: string; label?: string }[] = [];

    this.locationMap.push({
      start: node.startIndex,
      end: node.endIndex,
      nodeId: decisionId,
    });

    const bodyResult = this.processStatementOrBlock(
      body,
      exitId,
      loopContext,
      finallyContext
    );
    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);
    bodyResult.nodesConnectedToExit.forEach((id) =>
      nodesConnectedToExit.add(id)
    );

    if (bodyResult.entryNodeId) {
      edges.push({ from: decisionId, to: bodyResult.entryNodeId, label: "true" });
    } else {
      exitPoints.push({ id: decisionId, label: "true" });
    }
    exitPoints.push(...bodyResult.exitPoints);

    const alternative = node.childForFieldName("alternative");
    if (alternative) {
      const altResult = this.processAlternativeClause(
        alternative,
        exitId,
        loopContext,
        finallyContext
      );
      nodes.push(...altResult.nodes);
      edges.push(...altResult.edges);
      altResult.nodesConnectedToExit.forEach((id) =>
        nodesConnectedToExit.add(id)
      );

      if (altResult.entryNodeId) {
        edges.push({
          from: decisionId,
          to: altResult.entryNodeId,
          label: "false",
        });
      } else {
        exitPoints.push({ id: decisionId, label: "false" });
      }
      exitPoints.push(...altResult.exitPoints);
    } else {
      exitPoints.push({ id: decisionId, label: "false" });
    }

    return this.createProcessResult(
      nodes,
      edges,
      decisionId,
      exitPoints,
      nodesConnectedToExit
    );
  }

  private processForStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const result = this.createProcessResult();
    const initializer = node.childForFieldName("initialize");
    const condition = node.childForFieldName("condition");
    const update = node.childForFieldName("update");
    const body = node.childForFieldName("body");

    let previousId: string | undefined;
    if (initializer) {
      const initializerResult = this.processStatement(initializer, exitId);
      result.nodes.push(...initializerResult.nodes);
      result.edges.push(...initializerResult.edges);
      result.entryNodeId = initializerResult.entryNodeId;
      previousId = initializerResult.exitPoints[0]?.id;
    }

    const headerId = this.generateNodeId("for");
    const endId = this.generateNodeId("for_end");
    const updateId = update ? this.generateNodeId("for_update") : undefined;
    const continueTargetId = updateId || headerId;

    result.nodes.push(
      this.createSemanticNode(
        headerId,
        condition ? `for ${this.summarizeNode(condition)}` : "for",
        NodeType.LOOP_START,
        node
      )
    );
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: headerId });

    if (!result.entryNodeId) {
      result.entryNodeId = headerId;
    }
    if (previousId) {
      result.edges.push({ from: previousId, to: headerId });
    }

    if (update && updateId) {
      result.nodes.push(
        this.createSemanticNode(updateId, this.summarizeNode(update), NodeType.PROCESS, update)
      );
      this.locationMap.push({
        start: update.startIndex,
        end: update.endIndex,
        nodeId: updateId,
      });
      result.edges.push({ from: updateId, to: headerId });
    }

    const bodyResult = this.processStatementOrBlock(
      body,
      exitId,
      { breakTargetId: endId, continueTargetId },
      finallyContext
    );
    result.nodes.push(...bodyResult.nodes);
    result.edges.push(...bodyResult.edges);
    bodyResult.nodesConnectedToExit.forEach((id) =>
      result.nodesConnectedToExit.add(id)
    );

    if (bodyResult.entryNodeId) {
      result.edges.push({ from: headerId, to: bodyResult.entryNodeId, label: "true" });
    } else {
      result.edges.push({ from: headerId, to: continueTargetId, label: "true" });
    }

    bodyResult.exitPoints.forEach((exitPoint) => {
      if (!bodyResult.nodesConnectedToExit.has(exitPoint.id)) {
        result.edges.push({ from: exitPoint.id, to: continueTargetId, label: exitPoint.label });
      }
    });

    result.nodes.push(this.createSemanticNode(endId, "Loop End", NodeType.LOOP_END, node));
    this.locationMap.push({ start: node.endIndex - 1, end: node.endIndex, nodeId: endId });
    result.edges.push({ from: headerId, to: endId, label: "false" });
    result.exitPoints.push({ id: endId });
    return result;
  }

  private processForeachStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const headerId = this.generateNodeId("foreach");
    const endId = this.generateNodeId("foreach_end");
    const body = node.childForFieldName("body");
    const result = this.createProcessResult();

    result.nodes.push(
      this.createSemanticNode(headerId, this.summarizeForeach(node), NodeType.LOOP_START, node)
    );
    result.nodes.push(this.createSemanticNode(endId, "Loop End", NodeType.LOOP_END, node));
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: headerId });
    this.locationMap.push({ start: node.endIndex - 1, end: node.endIndex, nodeId: endId });
    result.entryNodeId = headerId;

    const bodyResult = this.processStatementOrBlock(
      body,
      exitId,
      { breakTargetId: endId, continueTargetId: headerId },
      finallyContext
    );
    result.nodes.push(...bodyResult.nodes);
    result.edges.push(...bodyResult.edges);
    bodyResult.nodesConnectedToExit.forEach((id) =>
      result.nodesConnectedToExit.add(id)
    );

    if (bodyResult.entryNodeId) {
      result.edges.push({ from: headerId, to: bodyResult.entryNodeId, label: "next" });
    } else {
      result.edges.push({ from: headerId, to: headerId, label: "next" });
    }

    bodyResult.exitPoints.forEach((exitPoint) => {
      if (!bodyResult.nodesConnectedToExit.has(exitPoint.id)) {
        result.edges.push({ from: exitPoint.id, to: headerId, label: exitPoint.label });
      }
    });

    result.edges.push({ from: headerId, to: endId, label: "done" });
    result.exitPoints.push({ id: endId });
    return result;
  }

  private processWhileStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const condition = node.childForFieldName("condition");
    const body = node.childForFieldName("body");
    const conditionId = this.generateNodeId("while");
    const endId = this.generateNodeId("while_end");
    const result = this.createProcessResult();

    result.nodes.push(
      this.createSemanticNode(
        conditionId,
        condition ? this.summarizeCondition(condition) : "while",
        NodeType.LOOP_START,
        condition || node
      )
    );
    result.nodes.push(this.createSemanticNode(endId, "Loop End", NodeType.LOOP_END, node));
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: conditionId });
    this.locationMap.push({ start: node.endIndex - 1, end: node.endIndex, nodeId: endId });
    result.entryNodeId = conditionId;

    const bodyResult = this.processStatementOrBlock(
      body,
      exitId,
      { breakTargetId: endId, continueTargetId: conditionId },
      finallyContext
    );
    result.nodes.push(...bodyResult.nodes);
    result.edges.push(...bodyResult.edges);
    bodyResult.nodesConnectedToExit.forEach((id) =>
      result.nodesConnectedToExit.add(id)
    );

    if (bodyResult.entryNodeId) {
      result.edges.push({ from: conditionId, to: bodyResult.entryNodeId, label: "true" });
    } else {
      result.edges.push({ from: conditionId, to: conditionId, label: "true" });
    }
    bodyResult.exitPoints.forEach((exitPoint) => {
      if (!bodyResult.nodesConnectedToExit.has(exitPoint.id)) {
        result.edges.push({ from: exitPoint.id, to: conditionId, label: exitPoint.label });
      }
    });
    result.edges.push({ from: conditionId, to: endId, label: "false" });
    result.exitPoints.push({ id: endId });
    return result;
  }

  private processDoStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const condition = node.childForFieldName("condition");
    const body = node.childForFieldName("body");
    const conditionId = this.generateNodeId("do_while");
    const endId = this.generateNodeId("do_end");
    const result = this.createProcessResult();
    const bodyResult = this.processStatementOrBlock(
      body,
      exitId,
      { breakTargetId: endId, continueTargetId: conditionId },
      finallyContext
    );

    result.nodes.push(...bodyResult.nodes);
    result.edges.push(...bodyResult.edges);
    bodyResult.nodesConnectedToExit.forEach((id) =>
      result.nodesConnectedToExit.add(id)
    );

    result.nodes.push(
      this.createSemanticNode(
        conditionId,
        condition ? this.summarizeCondition(condition) : "while",
        NodeType.DECISION,
        condition || node
      )
    );
    result.nodes.push(this.createSemanticNode(endId, "Loop End", NodeType.LOOP_END, node));
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: conditionId });
    this.locationMap.push({ start: node.endIndex - 1, end: node.endIndex, nodeId: endId });
    result.entryNodeId = bodyResult.entryNodeId || conditionId;

    bodyResult.exitPoints.forEach((exitPoint) => {
      if (!bodyResult.nodesConnectedToExit.has(exitPoint.id)) {
        result.edges.push({ from: exitPoint.id, to: conditionId, label: exitPoint.label });
      }
    });
    result.edges.push({ from: conditionId, to: bodyResult.entryNodeId || conditionId, label: "true" });
    result.edges.push({ from: conditionId, to: endId, label: "false" });
    result.exitPoints.push({ id: endId });
    return result;
  }

  private processSwitchStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const switchId = this.generateNodeId("switch");
    const endId = this.generateNodeId("switch_end");
    const condition = node.childForFieldName("condition");
    const body = node.childForFieldName("body");
    const result = this.createProcessResult();

    result.nodes.push(
      this.createSemanticNode(
        switchId,
        condition ? `switch ${this.summarizeCondition(condition)}` : "switch",
        NodeType.DECISION,
        condition || node
      )
    );
    result.nodes.push(this.createSemanticNode(endId, "End Switch", NodeType.MERGE, node));
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: switchId });
    result.entryNodeId = switchId;

    const clauses =
      body?.namedChildren.filter(
        (child) => child.type === "case_statement" || child.type === "default_statement"
      ) || [];

    if (clauses.length === 0) {
      result.edges.push({ from: switchId, to: endId });
      result.exitPoints.push({ id: endId });
      return result;
    }

    for (const clause of clauses) {
      const value = clause.childForFieldName("value");
      const caseLabel =
        clause.type === "default_statement"
          ? "default"
          : `case ${this.summarizeNode(value || clause)}`;
      const statements = clause.namedChildren.filter(
        (child) => child.id !== value?.id
      );
      const clauseResult = this.processStatementList(
        statements,
        exitId,
        { breakTargetId: endId, continueTargetId: loopContext?.continueTargetId || endId },
        finallyContext
      );

      result.nodes.push(...clauseResult.nodes);
      result.edges.push(...clauseResult.edges);
      clauseResult.nodesConnectedToExit.forEach((id) =>
        result.nodesConnectedToExit.add(id)
      );

      if (clauseResult.entryNodeId) {
        result.edges.push({
          from: switchId,
          to: clauseResult.entryNodeId,
          label: caseLabel,
        });
      } else {
        result.edges.push({ from: switchId, to: endId, label: caseLabel });
      }

      clauseResult.exitPoints.forEach((exitPoint) => {
        if (!clauseResult.nodesConnectedToExit.has(exitPoint.id)) {
          result.edges.push({ from: exitPoint.id, to: endId, label: exitPoint.label });
        }
      });
    }

    result.exitPoints.push({ id: endId });
    return result;
  }

  private processTryStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const tryId = this.generateNodeId("try");
    const result = this.createProcessResult();
    const exitPoints: { id: string; label?: string }[] = [];
    let activeFinallyContext = finallyContext;
    let finallyResult: ProcessResult | undefined;

    result.nodes.push(this.createSemanticNode(tryId, "try", NodeType.PROCESS, node));
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: tryId });
    result.entryNodeId = tryId;

    const finallyClause = node.namedChildren.find(
      (child) => child.type === "finally_clause"
    );
    if (finallyClause) {
      finallyResult = this.processStatementOrBlock(
        finallyClause.childForFieldName("body"),
        exitId,
        loopContext,
        finallyContext
      );
      result.nodes.push(...finallyResult.nodes);
      result.edges.push(...finallyResult.edges);
      finallyResult.nodesConnectedToExit.forEach((id) =>
        result.nodesConnectedToExit.add(id)
      );
      if (finallyResult.entryNodeId) {
        activeFinallyContext = { finallyEntryId: finallyResult.entryNodeId };
      }
    }

    const tryBody = this.processStatementOrBlock(
      node.childForFieldName("body"),
      exitId,
      loopContext,
      activeFinallyContext
    );
    result.nodes.push(...tryBody.nodes);
    result.edges.push(...tryBody.edges);
    tryBody.nodesConnectedToExit.forEach((id) =>
      result.nodesConnectedToExit.add(id)
    );
    if (tryBody.entryNodeId) {
      result.edges.push({ from: tryId, to: tryBody.entryNodeId });
    } else if (finallyResult?.entryNodeId) {
      result.edges.push({ from: tryId, to: finallyResult.entryNodeId });
    }

    tryBody.exitPoints.forEach((exitPoint) => {
      if (finallyResult?.entryNodeId) {
        result.edges.push({ from: exitPoint.id, to: finallyResult.entryNodeId, label: exitPoint.label });
      } else {
        exitPoints.push(exitPoint);
      }
    });

    const catchClauses = node.namedChildren.filter(
      (child) => child.type === "catch_clause"
    );
    catchClauses.forEach((catchClause) => {
      const typeNode = catchClause.childForFieldName("type");
      const catchLabel = typeNode ? `catch ${this.summarizeNode(typeNode)}` : "catch";
      const catchResult = this.processStatementOrBlock(
        catchClause.childForFieldName("body"),
        exitId,
        loopContext,
        activeFinallyContext
      );
      result.nodes.push(...catchResult.nodes);
      result.edges.push(...catchResult.edges);
      catchResult.nodesConnectedToExit.forEach((id) =>
        result.nodesConnectedToExit.add(id)
      );
      if (catchResult.entryNodeId) {
        result.edges.push({ from: tryId, to: catchResult.entryNodeId, label: catchLabel });
      }
      catchResult.exitPoints.forEach((exitPoint) => {
        if (finallyResult?.entryNodeId) {
          result.edges.push({ from: exitPoint.id, to: finallyResult.entryNodeId, label: exitPoint.label });
        } else {
          exitPoints.push(exitPoint);
        }
      });
    });

    if (finallyResult) {
      exitPoints.push(...finallyResult.exitPoints);
    }

    result.exitPoints.push(...exitPoints);
    return result;
  }

  private processAssignment(node: Parser.SyntaxNode): ProcessResult {
    const right = node.childForFieldName("right");
    if (right?.type === "conditional_expression") {
      return this.processConditionalAssignment(node, right);
    }

    return this.processProcessLike(node, NodeType.ASSIGNMENT);
  }

  private processConditionalAssignment(
    assignment: Parser.SyntaxNode,
    conditional: Parser.SyntaxNode
  ): ProcessResult {
    const left = assignment.childForFieldName("left");
    const children = conditional.namedChildren;
    if (children.length < 3 || !left) {
      return this.processProcessLike(assignment, NodeType.ASSIGNMENT);
    }

    const [condition, consequence, alternative] = children;
    const conditionId = this.generateNodeId("ternary");
    const trueId = this.generateNodeId("ternary_true");
    const falseId = this.generateNodeId("ternary_false");
    const target = this.escapeString(left.text);
    const nodes = [
      this.createSemanticNode(conditionId, condition.text, NodeType.DECISION, condition),
      this.createSemanticNode(
        trueId,
        `${target} = ${this.escapeString(consequence.text)}`,
        NodeType.ASSIGNMENT,
        assignment
      ),
      this.createSemanticNode(
        falseId,
        `${target} = ${this.escapeString(alternative.text)}`,
        NodeType.ASSIGNMENT,
        assignment
      ),
    ];
    const edges = [
      { from: conditionId, to: trueId, label: "true" },
      { from: conditionId, to: falseId, label: "false" },
    ];

    this.locationMap.push({
      start: conditional.startIndex,
      end: conditional.endIndex,
      nodeId: conditionId,
    });
    this.locationMap.push({
      start: assignment.startIndex,
      end: assignment.endIndex,
      nodeId: trueId,
    });
    this.locationMap.push({
      start: assignment.startIndex,
      end: assignment.endIndex,
      nodeId: falseId,
    });

    return this.createProcessResult(nodes, edges, conditionId, [
      { id: trueId },
      { id: falseId },
    ]);
  }

  private processReturnStatement(
    node: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const id = this.generateNodeId("return");
    const result = this.createProcessResult(
      [this.createSemanticNode(id, this.summarizeNode(node), NodeType.RETURN, node)],
      [{ from: id, to: finallyContext ? finallyContext.finallyEntryId : exitId }],
      id,
      [],
      new Set([id])
    );
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: id });
    return result;
  }

  private processReturnStatementForExpression(
    node: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const id = this.generateNodeId("return");
    const result = this.createProcessResult(
      [this.createSemanticNode(id, `return ${this.summarizeNode(node)}`, NodeType.RETURN, node)],
      [{ from: id, to: finallyContext ? finallyContext.finallyEntryId : exitId }],
      id,
      [],
      new Set([id])
    );
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: id });
    return result;
  }

  private processThrow(
    node: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const id = this.generateNodeId("throw");
    const result = this.createProcessResult(
      [this.createSemanticNode(id, this.summarizeNode(node), NodeType.EXCEPTION, node)],
      [{ from: id, to: finallyContext ? finallyContext.finallyEntryId : exitId }],
      id,
      [],
      new Set([id])
    );
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: id });
    return result;
  }

  private processBreakStatement(
    node: Parser.SyntaxNode,
    loopContext: LoopContext
  ): ProcessResult {
    const id = this.generateNodeId("break");
    const result = this.createProcessResult(
      [this.createSemanticNode(id, "break", NodeType.BREAK_CONTINUE, node)],
      [{ from: id, to: loopContext.breakTargetId }],
      id,
      [],
      new Set([id])
    );
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: id });
    return result;
  }

  private processContinueStatement(
    node: Parser.SyntaxNode,
    loopContext: LoopContext
  ): ProcessResult {
    const id = this.generateNodeId("continue");
    const result = this.createProcessResult(
      [this.createSemanticNode(id, "continue", NodeType.BREAK_CONTINUE, node)],
      [{ from: id, to: loopContext.continueTargetId }],
      id,
      [],
      new Set([id])
    );
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: id });
    return result;
  }

  private processProcessLike(
    node: Parser.SyntaxNode,
    nodeType: NodeType,
    prefix?: string
  ): ProcessResult {
    const id = this.generateNodeId(this.getPrefixForNodeType(nodeType));
    const label = prefix ? `${prefix} ${this.summarizeNode(node)}` : this.summarizeNode(node);
    const result = this.createProcessResult(
      [this.createSemanticNode(id, label, nodeType, node)],
      [],
      id,
      [{ id }]
    );
    this.locationMap.push({ start: node.startIndex, end: node.endIndex, nodeId: id });
    return result;
  }

  private processStatementOrBlock(
    node: Parser.SyntaxNode | null | undefined,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    if (!node) {
      return this.createProcessResult();
    }
    if (node.type === "compound_statement" || node.type === "switch_block") {
      return this.processBlock(node, exitId, loopContext, finallyContext);
    }
    return this.processStatement(node, exitId, loopContext, finallyContext);
  }

  private findTargetNode(
    root: Parser.SyntaxNode,
    position: number
  ): Parser.SyntaxNode | undefined {
    const candidates = [
      ...root.descendantsOfType("function_definition"),
      ...root.descendantsOfType("method_declaration"),
      ...root.descendantsOfType("assignment_expression").filter((node) => {
        const right = node.childForFieldName("right");
        return right?.type === "anonymous_function" || right?.type === "arrow_function";
      }),
    ].filter((node) => position >= node.startIndex && position <= node.endIndex);

    return candidates.sort(
      (a, b) => a.endIndex - a.startIndex - (b.endIndex - b.startIndex)
    )[0];
  }

  private findTargetNodeByName(
    root: Parser.SyntaxNode,
    functionName: string
  ): Parser.SyntaxNode | undefined {
    return (
      root
        .descendantsOfType(["function_definition", "method_declaration"])
        .find((node) => this.extractFunctionName(node) === functionName) ||
      root
        .descendantsOfType("assignment_expression")
        .find((node) => this.extractAssignedFunctionName(node) === functionName)
    );
  }

  private findAssignedFunction(
    root: Parser.SyntaxNode
  ): Parser.SyntaxNode | undefined {
    return root.descendantsOfType("assignment_expression").find((node) => {
      const right = node.childForFieldName("right");
      return right?.type === "anonymous_function" || right?.type === "arrow_function";
    });
  }

  private getFunctionBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === "assignment_expression") {
      const right = node.childForFieldName("right");
      return right?.childForFieldName("body") || null;
    }
    return node.childForFieldName("body");
  }

  private getDisplayName(node: Parser.SyntaxNode): string {
    if (node.type === "assignment_expression") {
      return this.extractAssignedFunctionName(node) || "[anonymous]";
    }
    return this.extractFunctionName(node) || "[anonymous]";
  }

  private getFunctionKind(node: Parser.SyntaxNode): string {
    if (node.type === "method_declaration") {
      return "method";
    }
    if (node.type === "assignment_expression") {
      const right = node.childForFieldName("right");
      return right?.type === "arrow_function" ? "arrow function" : "anonymous function";
    }
    return "function";
  }

  private extractFunctionName(
    node: Parser.SyntaxNode | undefined
  ): string | undefined {
    if (!node) {
      return undefined;
    }

    const name = node.childForFieldName("name");
    if (node.type === "method_declaration") {
      const className = this.findEnclosingClassName(node);
      return className && name ? `${className}::${name.text}` : name?.text;
    }
    return name?.text;
  }

  private extractAssignedFunctionName(
    node: Parser.SyntaxNode
  ): string | undefined {
    const right = node.childForFieldName("right");
    if (right?.type !== "anonymous_function" && right?.type !== "arrow_function") {
      return undefined;
    }
    return node.childForFieldName("left")?.text;
  }

  private findEnclosingClassName(node: Parser.SyntaxNode): string | undefined {
    let parent = node.parent;
    while (parent) {
      if (parent.type === "class_declaration") {
        return parent.childForFieldName("name")?.text;
      }
      parent = parent.parent;
    }
    return undefined;
  }

  private summarizeCondition(node: Parser.SyntaxNode): string {
    const first = node.namedChild(0);
    return this.summarizeNode(first || node);
  }

  private summarizeForeach(node: Parser.SyntaxNode): string {
    const text = node.text.replace(/\s+/g, " ").trim();
    const bodyIndex = text.indexOf("{");
    return bodyIndex > -1
      ? text.slice(0, bodyIndex).trim()
      : text.slice(0, 120);
  }

  private summarizeNode(node: Parser.SyntaxNode): string {
    return node.text.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  private getPrefixForNodeType(nodeType: NodeType): string {
    switch (nodeType) {
      case NodeType.ASSIGNMENT:
        return "assign";
      case NodeType.FUNCTION_CALL:
        return "call";
      default:
        return "stmt";
    }
  }
}
