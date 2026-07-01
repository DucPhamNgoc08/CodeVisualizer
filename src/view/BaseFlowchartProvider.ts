import * as vscode from "vscode";
import { analyzeCode } from "../core/analyzer";
import { LocationMapEntry, NodeType } from "../ir/ir";
import { EnhancedMermaidGenerator } from "../core/EnhancedMermaidGenerator";
import { LLMManager } from "../core/llm/LLMManager";
import { getExtensionContext } from "../core/llm/LLMContext";
import { EnvironmentDetector } from "../core/utils/EnvironmentDetector";
import { MetricsAnalyzer, CodeMetrics } from "../core/utils/MetricsAnalyzer";

const MERMAID_VERSION = "11.8.0";
const SVG_PAN_ZOOM_VERSION = "3.6.1";

// Define specific types for messages from the webview to avoid `any`
export type HighlightCodeMessage = {
  command: "highlightCode";
  payload: { start: number; end: number };
};

export type ExportMessage = {
  command: "export";
  payload: { fileType: "svg" | "png"; data: string };
};

export type ExportErrorMessage = {
  command: "exportError";
  payload: { error: string };
};

export type OpenInPanelMessage = {
  command: "openInPanel";
  payload: {};
};

// New message type for copying mermaid code
export type CopyMermaidMessage = {
  command: "copyMermaid";
  payload: { code: string };
};

export type RequestLLMLabelsMessage = {
  command: "requestLLMLabels";
  payload: {};
};

export type DisableLLMLabelsMessage = {
  command: "disableLLMLabels";
  payload: {};
};

export type SetupLLMMessage = {
  command: "setupLLM";
  payload: {};
};

export type UserInteractionStartMessage = {
  command: "userInteractionStart";
  payload: {};
};

export type UserInteractionEndMessage = {
  command: "userInteractionEnd";
  payload: {};
};

export type DrillIntoFunctionMessage = {
  command: "drillIntoFunction";
  payload: { start: number; end: number };
};

export type WebviewMessage =
  | HighlightCodeMessage
  | ExportMessage
  | ExportErrorMessage
  | OpenInPanelMessage
  | CopyMermaidMessage
  | RequestLLMLabelsMessage
  | DisableLLMLabelsMessage
  | SetupLLMMessage
  | UserInteractionStartMessage
  | UserInteractionEndMessage
  | DrillIntoFunctionMessage;

/** Node types that represent a call to another function/method worth drilling into. */
const DRILLABLE_NODE_TYPES = new Set<NodeType>([
  NodeType.FUNCTION_CALL,
  NodeType.METHOD_CALL,
  NodeType.MACRO_CALL,
  NodeType.SUBROUTINE,
]);

export interface FlowchartViewContext {
  isPanel: boolean;
  showPanelButton: boolean;
}

/**
 * Abstract base class for flowchart providers that contains shared functionality
 * between sidebar and panel implementations.
 */
export abstract class BaseFlowchartProvider {
  protected _disposables: vscode.Disposable[] = [];
  protected _locationMap: LocationMapEntry[] = [];
  protected _currentFunctionRange: vscode.Range | undefined;
  protected _debounceTimer?: NodeJS.Timeout;
  protected _currentDocument?: vscode.TextDocument;
  protected _currentPosition?: number;
  protected _isUpdating: boolean = false;
  protected _eventListenersSetup: boolean = false;
  protected _mermaidCodeOriginal?: string;
  protected _mermaidCodeLLM?: string;
  private _cachedClickHandlers?: { source: string; lines: string[] };
  protected _userInteracting: boolean = false;

  constructor(protected readonly _extensionUri: vscode.Uri) {
    // Detect environment and apply any necessary compatibility fixes
    this.initializeEnvironment();
    
    // Listen for configuration changes to update themes
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("codevisualizer.theme")) {
          // Refresh the current view when theme changes
          this.updateView(vscode.window.activeTextEditor);
        }
      })
    );
  }

  /**
   * Initialize environment-specific settings and compatibility fixes
   */
  private initializeEnvironment(): void {
    const env = EnvironmentDetector.detectEnvironment();
    
    if (env.requiresCompatibilityMode) {
      console.log(`CodeVisualizer: Running in compatibility mode for ${env.editor}`);
      
      // Add any environment-specific initialization here
      if (env.isCursor) {
        // Cursor-specific initialization
        console.log("CodeVisualizer: Applying Cursor-specific compatibility settings");
      } else if (env.isWindsurf) {
        // Windsurf-specific initialization  
        console.log("CodeVisualizer: Applying Windsurf-specific compatibility settings");
      } else if (env.isTrae) {
        // Trae-specific initialization
        console.log("CodeVisualizer: Applying Trae-specific compatibility settings");
      }
    }
  }

  /**
   * Abstract methods that subclasses must implement
   */
  protected abstract getWebview(): vscode.Webview | undefined;
  protected abstract setWebviewHtml(html: string): void;
  protected abstract getViewContext(): FlowchartViewContext;

  /**
   * Set up event listeners for editor changes and selection changes
   */
  protected setupEventListeners(): void {
    // Prevent setting up listeners multiple times
    if (this._eventListenersSetup) {
      return;
    }

    // Listen for changes to the active editor
    vscode.window.onDidChangeActiveTextEditor(
      async (editor) => {
        await this.updateView(editor);
      },
      null,
      this._disposables
    );

    // Listen for selection changes in the active editor
    vscode.window.onDidChangeTextEditorSelection(
      async (event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          const selection = event.selections[0];
          // If the cursor is still within the same function, just highlight the node
          if (
            this._currentFunctionRange &&
            this._currentFunctionRange.contains(selection)
          ) {
            const offset = event.textEditor.document.offsetAt(selection.active);
            const entry = this._locationMap.find(
              (e) => offset >= e.start && offset <= e.end
            );
            this.highlightNode(entry ? entry.nodeId : null);
          } else {
            // If the cursor moves out of the function, regenerate the flowchart
            await this.updateView(event.textEditor);
          }
        }
      },
      null,
      this._disposables
    );

    // Listen for changes to the document text for live updates
    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          // Clear the previous timer if it exists
          if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
          }
          // Set a new timer to update the view after a short delay (e.g., 500ms)
          this._debounceTimer = setTimeout(() => {
            this.updateView(vscode.window.activeTextEditor);
          }, 500);
        }
      },
      null,
      this._disposables
    );

    this._eventListenersSetup = true;
  }

  /**
   * Handle messages from the webview
   */
  protected async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    switch (message.command) {
      case "highlightCode": {
        const { start, end } = message.payload;
        // Use the document this flowchart was generated from (rather than
        // whatever editor happens to be active) so that clicking a box in a
        // popup flowchart always navigates to the right file.
        const document = this._currentDocument;
        if (document) {
          const startPos = document.positionAt(start);
          const endPos = document.positionAt(end);
          const range = new vscode.Range(startPos, endPos);

          // Reuse the already-active editor if it's already showing this
          // document (the common case) so we don't disturb its view column;
          // otherwise (e.g. clicking a box inside a popup) open it fresh.
          const activeEditor = vscode.window.activeTextEditor;
          const editor =
            activeEditor && activeEditor.document === document
              ? activeEditor
              : await vscode.window.showTextDocument(document, {
                  viewColumn: vscode.ViewColumn.One,
                });
          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
        break;
      }

      case "export": {
        await this.handleExport(message.payload);
        break;
      }

      case "exportError": {
        vscode.window.showErrorMessage(
          `Export failed: ${message.payload.error}`
        );
        break;
      }

      case "openInPanel": {
        // This will be handled by the FlowchartPanelProvider
        vscode.commands.executeCommand("codevisualizer.openFlowchartInPanel");
        break;
      }

      case "copyMermaid": {
        await vscode.env.clipboard.writeText(message.payload.code);
        vscode.window.showInformationMessage("Mermaid code copied to clipboard!");
        break;
      }

      case "requestLLMLabels": {
        console.log("CodeVisualizer LLM: requestLLMLabels received");
        await this.handleLLMTranslate();
        break;
      }

      case "disableLLMLabels": {
        console.log("CodeVisualizer LLM: disableLLMLabels received");
        const webview = this.getWebview();
        if (webview && this._mermaidCodeOriginal) {
          webview.postMessage({ command: "applyMermaid", payload: { mermaid: this._mermaidCodeOriginal, llmApplied: false } });
        }
        break;
      }

      case "setupLLM": {
        console.log("CodeVisualizer LLM: setupLLM received");
        await vscode.commands.executeCommand("codevisualizer.llm.enableLabels");
        const ctx = getExtensionContext();
        const availability = ctx ? await LLMManager.getAvailability(ctx) : { enabled: false, provider: "openai", model: "" };
        const webview = this.getWebview();
        if (webview) {
          webview.postMessage({ command: "llmAvailability", payload: availability });
        }
        break;
      }

      case "userInteractionStart": {
        this._userInteracting = true;
        break;
      }

      case "userInteractionEnd": {
        this._userInteracting = false;
        break;
      }

      case "drillIntoFunction": {
        await this.drillIntoFunction(message.payload);
        break;
      }
    }
  }

  /**
   * Resolves the definition of the call at the given offset (using the
   * workspace's language providers) and opens a standalone popup showing
   * that callee's own code flow, without disturbing this flowchart.
   */
  private async drillIntoFunction(payload: {
    start: number;
    end: number;
  }): Promise<void> {
    const document = this._currentDocument;
    if (!document) {
      return;
    }
    try {
      const position = document.positionAt(payload.start);
      const results = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[] | undefined
      >("vscode.executeDefinitionProvider", document.uri, position);

      if (!results || results.length === 0) {
        vscode.window.showInformationMessage(
          "Could not resolve a definition for this call."
        );
        return;
      }

      const first = results[0];
      const targetUri = "targetUri" in first ? first.targetUri : first.uri;
      const targetRange =
        "targetSelectionRange" in first && first.targetSelectionRange
          ? first.targetSelectionRange
          : "targetRange" in first
          ? first.targetRange
          : first.range;

      // Lazily required to avoid a circular import: FunctionFlowPopupProvider
      // extends BaseFlowchartProvider.
      const { FunctionFlowPopupProvider } = require("./FunctionFlowPopupProvider") as
        typeof import("./FunctionFlowPopupProvider");
      const popup = new FunctionFlowPopupProvider(this._extensionUri);
      await popup.showFor(targetUri, targetRange);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Could not open function definition: ${message}`
      );
    }
  }

  /**
   * Merge click handlers from original Mermaid into a translated Mermaid string
   * to preserve node interactivity after LLM rewrites.
   */
  private static isClickLine(line: string): boolean {
    let index = 0;
    // Skip leading spaces and tabs without allocating new strings
    while (index < line.length) {
      const code = line.charCodeAt(index);
      if (code !== 32 && code !== 9) break; // 32 = space, 9 = tab
      index += 1;
    }
    return line.startsWith("click ", index);
  }

  private static sanitizeMermaidNodeId(nodeId: string): string {
    return nodeId
      .replace(/\s+/g, "_")
      .replace(/[^\w]/g, "")
      .replace(/_+/g, "_");
  }

  private extractClickHandlers(src: string): string[] {
    if (this._cachedClickHandlers && this._cachedClickHandlers.source === src) {
      return this._cachedClickHandlers.lines;
    }
    const lines: string[] = [];
    const srcLines = src.split(/\r?\n/);
    for (const line of srcLines) {
      if (BaseFlowchartProvider.isClickLine(line)) {
        lines.push(line);
      }
    }
    this._cachedClickHandlers = { source: src, lines };
    return lines;
  }

  private extractMetadata(src: string): string[] {
    return src.split(/\r?\n/).filter(line => line.trim().startsWith("%%"));
  }

  private mergeMetadata(metadata: string[], translatedSrc: string): string {
    if (metadata.length === 0) return translatedSrc;
    return `${translatedSrc}\n${metadata.join("\n")}\n`;
  }

  private mergeClickHandlers(originalSrc: string, translatedSrc: string): string {
    try {
      const origClicks = this.extractClickHandlers(originalSrc);
      if (origClicks.length === 0) return translatedSrc;
      const withoutClicks = translatedSrc
        .split(/\r?\n/)
        .filter((l) => !BaseFlowchartProvider.isClickLine(l))
        .join("\n");
      // Append original click lines at end
      return `${withoutClicks}\n${origClicks.join("\n")}\n`;
    } catch {
      return translatedSrc;
    }
  }

  private async handleLLMTranslate(): Promise<void> {
    const ctx = getExtensionContext();
    const webview = this.getWebview();
    if (!ctx || !webview) return;
    if (!this._mermaidCodeOriginal) return;
    try {
      console.log("CodeVisualizer LLM: translateIfNeeded start");
      const metadata = this.extractMetadata(this._mermaidCodeOriginal);
      let translated = await LLMManager.translateIfNeeded(ctx, this._mermaidCodeOriginal);
      console.log("CodeVisualizer LLM: translateIfNeeded done");
      if (translated) {
        // Preserve click interactivity and metadata
        translated = this.mergeMetadata(metadata, translated);
        translated = this.mergeClickHandlers(this._mermaidCodeOriginal, translated);
        this._mermaidCodeLLM = translated;
        webview.postMessage({ command: "applyMermaid", payload: { mermaid: translated, llmApplied: true } });
      } else {
        vscode.window.showWarningMessage("LLM labels could not be applied. Using original labels.");
        // Notify webview to reset LLM UI state
        try {
          webview.postMessage({ command: "applyMermaid", payload: { mermaid: this._mermaidCodeOriginal, llmApplied: false } });
        } catch {}
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`LLM translation failed: ${message}`);
    }
  }

  /**
   * Handle export functionality
   */
  private async handleExport(payload: {
    fileType: "svg" | "png";
    data: string;
  }): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showErrorMessage(
        "Cannot export: No active text editor found."
      );
      return;
    }

    const { fileType, data } = payload;
    const documentUri = activeEditor.document.uri;

    const defaultDirectory = vscode.Uri.file(
      require("path").dirname(documentUri.fsPath)
    );
    const defaultFileUri = vscode.Uri.file(
      require("path").join(defaultDirectory.fsPath, `flowchart.${fileType}`)
    );

    const filters: { [name: string]: string[] } =
      fileType === "svg"
        ? { "SVG Images": ["svg"] }
        : { "PNG Images": ["png"] };

    const uri = await vscode.window.showSaveDialog({
      filters,
      defaultUri: defaultFileUri,
    });

    if (uri) {
      const buffer = Buffer.from(data, fileType === "png" ? "base64" : "utf-8");
      try {
        await vscode.workspace.fs.writeFile(uri, buffer);
        vscode.window.showInformationMessage(
          `Successfully exported flowchart to ${uri.fsPath}`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Failed to export flowchart: ${message}`
        );
      }
    }
  }

  /**
   * Highlight a specific node in the flowchart
   */
  public highlightNode(nodeId: string | null): void {
    const webview = this.getWebview();
    if (webview) {
      // Sanitize nodeId before sending to webview to match sanitized IDs in the diagram
      const sanitizedNodeId = nodeId ? BaseFlowchartProvider.sanitizeMermaidNodeId(nodeId) : null;
      webview.postMessage({
        command: "highlightNode",
        payload: { nodeId: sanitizedNodeId },
      });
    }
  }

  /**
   * Force update the view, ignoring the shouldUpdate check
   */
  public async forceUpdateView(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    // Reset the updating flag to ensure we can proceed
    this._isUpdating = false;

    // Clear current state to force regeneration
    this._currentDocument = undefined;
    this._currentPosition = undefined;
    this._currentFunctionRange = undefined;

    await this.updateView(editor);
  }

  /**
   * Main method to update the webview content. It analyzes the code and redraws the flowchart.
   */
  public async updateView(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    const webview = this.getWebview();
    if (!webview) {
      return;
    }

    // Prevent updates when user is interacting with the webview
    if (this._userInteracting) {
      return;
    }

    // Prevent multiple simultaneous updates
    if (this._isUpdating) {
      return;
    }

    if (!editor) {
      this.setWebviewHtml(
        this.getLoadingHtml("Please open a file to see the flowchart.")
      );
      this._currentDocument = undefined;
      this._currentPosition = undefined;
      return;
    }

    await this.updateViewForDocument(editor.document, editor.selection.active);
  }

  protected async updateViewForDocument(
    document: vscode.TextDocument,
    activePosition: vscode.Position
  ): Promise<void> {
    const webview = this.getWebview();
    if (!webview) {
      return;
    }

    // Prevent updates when user is interacting with the webview
    if (this._userInteracting) {
      return;
    }

    // Prevent multiple simultaneous updates
    if (this._isUpdating) {
      return;
    }

    const position = document.offsetAt(activePosition);

    // Check if we need to update - avoid unnecessary regeneration
    const shouldUpdate = this._shouldUpdate(document, position);
    if (!shouldUpdate) {
      // Just update highlighting if we're still in the same function
      if (
        this._currentFunctionRange &&
        this._currentFunctionRange.contains(activePosition)
      ) {
        const entry = this._locationMap.find(
          (e) => position >= e.start && position <= e.end
        );
        this.highlightNode(entry ? entry.nodeId : null);
      }
      return;
    }

    this._isUpdating = true;
    this.setWebviewHtml(this.getLoadingHtml("Generating flowchart..."));

    try {
      const flowchartIR = await analyzeCode(
        document.getText(),
        document.languageId,
        undefined,
        position
      );

      this._locationMap = flowchartIR.locationMap;
      this._currentDocument = document;
      this._currentPosition = position;

      if (flowchartIR.functionRange) {
        this._currentFunctionRange = new vscode.Range(
          document.positionAt(flowchartIR.functionRange.start),
          document.positionAt(flowchartIR.functionRange.end)
        );
      } else {
        this._currentFunctionRange = undefined;
      }

      // Generate Mermaid diagram from FlowchartIR with enhanced styling
      const vsCodeTheme =
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
          ? "dark"
          : "light";

      // Read the selected theme from user configuration
      const config = vscode.workspace.getConfiguration("codevisualizer");
      const selectedTheme = config.get<string>(
        "theme",
        "monokai"
      );

      const mermaidGenerator = new EnhancedMermaidGenerator(
        selectedTheme,
        vsCodeTheme
      );
      const mermaidCode = mermaidGenerator.generate(flowchartIR);
      this._mermaidCodeOriginal = mermaidCode;
      this._mermaidCodeLLM = undefined;
      // Calculate code metrics
      const codeMetrics = MetricsAnalyzer.analyze(flowchartIR, document.getText());

      // Node ids are sanitized in-place by the generator above, so this map's
      // keys line up with the ids that end up in the rendered SVG.
      const callNodeLocations: Record<string, { start: number; end: number }> = {};
      const nodeLocations: Record<string, { start: number; end: number }> = {};
      for (const entry of flowchartIR.locationMap) {
        nodeLocations[BaseFlowchartProvider.sanitizeMermaidNodeId(entry.nodeId)] = {
          start: entry.start,
          end: entry.end,
        };
      }
      for (const node of flowchartIR.nodes) {
        if (node.nodeType && DRILLABLE_NODE_TYPES.has(node.nodeType) && node.location) {
          callNodeLocations[node.id] = {
            start: node.location.start,
            end: node.location.end,
          };
        }
      }

      const ctx = getExtensionContext();
      const availability = ctx ? await LLMManager.getAvailability(ctx) : { enabled: false, provider: "openai", model: "" };
      this.setWebviewHtml(this.getWebviewContent(mermaidCode, this.getNonce(), availability, codeMetrics, callNodeLocations, nodeLocations));

      // After updating the view, immediately highlight the node for the current cursor
      const offset = document.offsetAt(activePosition);
      const entry = this._locationMap.find(
        (e) => offset >= e.start && offset <= e.end
      );
      this.highlightNode(entry ? entry.nodeId : null);

    } catch (error) {
      console.error("Flowchart generation failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";
      this.setWebviewHtml(this.getLoadingHtml(`Error: ${errorMessage}`));
    } finally {
      this._isUpdating = false;
    }
  }

  /**
   * Determines if the view should be updated based on document and position changes
   */
  private _shouldUpdate(
    document: vscode.TextDocument,
    position: number
  ): boolean {
    // Always update if no current document
    if (!this._currentDocument) {
      return true;
    }

    // Update if document changed (different file)
    if (this._currentDocument.uri.toString() !== document.uri.toString()) {
      return true;
    }

    // Update if document version changed (content was modified)
    if (this._currentDocument.version !== document.version) {
      return true;
    }

    // Update if we moved to a different function or there's no current function range
    if (!this._currentFunctionRange) {
      return true;
    }

    const currentPos = document.positionAt(position);
    if (!this._currentFunctionRange.contains(currentPos)) {
      return true;
    }

    // Don't update if we're just moving within the same function
    return false;
  }

  /**
   * Generates the complete HTML content for the webview panel.
   */
  protected getWebviewContent(
    flowchartSyntax: string,
    nonce: string,
    llmAvailability?: { enabled: boolean; provider: string; model: string },
    codeMetrics?: CodeMetrics,
    callNodeLocations?: Record<string, { start: number; end: number }>,
    nodeLocations?: Record<string, { start: number; end: number }>
  ): string {
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? "dark"
        : "default";

    const context = this.getViewContext();

    const llm = llmAvailability || { enabled: false, provider: "openai", model: "" };
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">

        <meta http-equiv="Content-Security-Policy" content="${EnvironmentDetector.getContentSecurityPolicy(nonce)}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code Flowchart</title>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js"></script>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@${SVG_PAN_ZOOM_VERSION}/dist/svg-pan-zoom.min.js"></script>
        <style>
            :root {
                --hover-fill: rgba(255, 165, 0, 0.3);
                --hover-stroke: #ff6b35;
                --hover-stroke-width: 3px;
                --hover-edge-color: #ff6b35;
                --hover-edge-width: 3px;
            }

            body, html {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
                overflow: hidden;
            }
            #container {
                width: 100%;
                height: 100%;
                ${
                  context.isPanel
                    ? "margin-top: 60px; height: calc(100% - 80px);"
                    : ""
                }
            }
            .mermaid { width: 100%; height: 100%; }
            .mermaid svg { width: 100%; height: 100%; }

            /* Node highlighting styles */
            .highlighted > rect,
            .highlighted > polygon,
            .highlighted > circle,
            .highlighted > path {
                stroke: var(--vscode-editor-selectionBackground) !important;
                stroke-width: 4px !important;
            }

            /* Transitions */
            .mermaid svg .node > *, .mermaid .edge-path, .mermaid .edge-path path, .mermaid .arrowhead, .mermaid .arrowhead path, .mermaid line, .mermaid g > path {
                transition: fill 0.15s ease-in-out, stroke 0.15s ease-in-out, filter 0.15s ease-in-out, stroke-width 0.15s ease-in-out;
            }


            
            /* Hovered node, child, or edge */
            .mermaid svg .node.hover-highlight > *,
            .mermaid svg .node.child-highlight > * {
                fill: var(--hover-fill) !important;
                stroke: var(--hover-stroke) !important;
                stroke-width: var(--hover-stroke-width) !important;
                filter: drop-shadow(0 0 8px var(--hover-stroke));
            }
            
            /* Enhanced edge highlighting that works with different Mermaid edge structures */
            .mermaid g[class*="edge"].hover-highlight > *,
            .mermaid g[id^="L_"].hover-highlight > *,
            .mermaid path[class*="edge"].hover-highlight,
            .mermaid g.hover-highlight > path,
            .mermaid g.edgePath.hover-highlight > path.path {
                stroke: var(--hover-edge-color) !important;
                stroke-width: var(--hover-edge-width) !important;
                filter: drop-shadow(0 0 2px var(--hover-edge-color));
            }

            /* Arrow markers for highlighted edges */
            .mermaid g[class*="edge"].hover-highlight polygon,
            .mermaid g[id^="L_"].hover-highlight polygon,
            .mermaid g.hover-highlight polygon,
            .mermaid g.edgePath.hover-highlight polygon {
                fill: var(--hover-edge-color) !important;
                stroke: var(--hover-edge-color) !important;
            }

            /* Edge labels */
            .mermaid g[class*="edge"].hover-highlight text,
            .mermaid g[id^="L_"].hover-highlight text,
            .mermaid g.hover-highlight text {
                fill: var(--hover-edge-color) !important;
                font-weight: bold !important;
            }
            
            #mermaid-source { display: none; }

            /* Drill-in icon shown on function/method-call nodes */
            .drill-icon { cursor: pointer; }
            .drill-icon .drill-icon-bg {
                fill: var(--vscode-button-background);
                stroke: var(--vscode-button-border, var(--vscode-panel-border));
                stroke-width: 1px;
                opacity: 0.85;
            }
            .drill-icon:hover .drill-icon-bg {
                fill: var(--vscode-button-hoverBackground);
                opacity: 1;
            }
            .drill-icon .drill-icon-glyph {
                font-size: 13px;
                fill: var(--vscode-button-foreground);
                pointer-events: none;
                user-select: none;
            }

            /* Other styles for controls */
            ${ this.getStylesForControls(context) }
        </style>
    </head>
    <body>
        ${ this.getHtmlForControls(context, codeMetrics) }
        <div id="container">
            <div class="mermaid">${flowchartSyntax}</div>
        </div>
        <div id="mermaid-source">${flowchartSyntax.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            const INITIAL_LLM = ${JSON.stringify(llm)};
            const CALL_NODES = ${JSON.stringify(callNodeLocations || {})};
            const NODE_LOCATIONS = ${JSON.stringify(nodeLocations || {})};
            let isLLMEnabled = false;
            let webviewInteractionTimeout = null;
            let suppressNodeClickUntil = 0;

            function notifyWebviewInteractionStart() {
                vscode.postMessage({ command: 'userInteractionStart', payload: {} });
                if (webviewInteractionTimeout) {
                    clearTimeout(webviewInteractionTimeout);
                }
            }

            function notifyWebviewInteractionEnd() {
                if (webviewInteractionTimeout) {
                    clearTimeout(webviewInteractionTimeout);
                }
                webviewInteractionTimeout = setTimeout(() => {
                    vscode.postMessage({ command: 'userInteractionEnd', payload: {} });
                }, 300);
            }

            function onNodeClick(start, end) {
                // Mermaid still evaluates generated click directives, but the
                // extension handles node clicks below so drill-icon clicks can
                // be separated from box-body clicks reliably.
            }

            let highlightedNodeId = null;

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'highlightNode':
                        if (highlightedNodeId) {
                            const oldElem = document.getElementById(highlightedNodeId);
                            if (oldElem) oldElem.classList.remove('highlighted');
                        }

                        const newId = message.payload.nodeId;
                        if (newId) {
                            const newElem = document.getElementById(newId);
                            if (newElem) newElem.classList.add('highlighted');
                        }
                        highlightedNodeId = newId;
                        break;

                    case 'applyMermaid': {
                        const mermaidDiv = document.querySelector('.mermaid');
                        const sourceDiv = document.getElementById('mermaid-source');
                        if (mermaidDiv && sourceDiv) {
                            const newSource = message.payload.mermaid;
                            
                            // Clear existing SVG first
                            const existingSvg = mermaidDiv.querySelector('svg');
                            if (existingSvg) {
                                existingSvg.remove();
                            }
                            
                            // Reset processed state to allow re-render
                            mermaidDiv.removeAttribute('data-processed');
                            
                            // Ensure it starts with a valid graph header
                            const idx = newSource.toLowerCase().indexOf('graph ');
                            const finalSrc = idx >= 0 ? newSource.slice(idx) : newSource;
                            
                            // Update source
                            mermaidDiv.textContent = finalSrc;
                            sourceDiv.textContent = newSource.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            
                            // Re-run mermaid rendering (Mermaid v11 API)
                            const renderMermaid = async () => {
                                try {
                                    if (typeof mermaid.run === 'function') {
                                        await mermaid.run({ querySelector: '.mermaid' });
                                    } else if (typeof mermaid.init === 'function') {
                                        // Fallback for older API
                                        mermaid.init(undefined, '.mermaid');
                                    }
                                    
                                    // Wait for SVG to be rendered, then setup interactions
                                    let attempts = 0;
                                    const maxAttempts = 20; // Wait up to 2 seconds
                                    const checkAndSetup = () => {
                                        const svgElement = document.querySelector('.mermaid svg');
                                        if (svgElement) {
                                            setupInteractions(svgElement);
                                        } else if (attempts < maxAttempts) {
                                            attempts++;
                                            setTimeout(checkAndSetup, 100);
                                        } else {
                                            console.warn('[CodeVisualizer] SVG not found after mermaid re-render');
                                        }
                                    };
                                    checkAndSetup();
                                } catch (error) {
                                    console.error('[CodeVisualizer] Error re-rendering mermaid:', error);
                                }
                            };
                            
                            renderMermaid();
                            
                            // Mark LLM enabled only after a successful apply if requested
                            try {
                                if (message.payload && message.payload.llmApplied) {
                                    isLLMEnabled = true;
                                    localStorage.setItem('codevisualizer-llm-enabled', 'true');
                                    const llmToggle = document.getElementById('llm-toggle');
                                    if (llmToggle) {
                                        llmToggle.textContent = '✓ LLM';
                                        llmToggle.title = 'Disable LLM labels';
                                        llmToggle.removeAttribute('disabled');
                                    }
                                } else {
                                    // If this was a disable request, ensure state reflects disabled
                                    isLLMEnabled = false;
                                    localStorage.setItem('codevisualizer-llm-enabled', 'false');
                                    const llmToggle = document.getElementById('llm-toggle');
                                    if (llmToggle) {
                                        llmToggle.textContent = 'LLM';
                                        llmToggle.title = 'Enable LLM labels';
                                        llmToggle.removeAttribute('disabled');
                                    }
                                }
                            } catch {}
                        }
                        break;
                    }
                    case 'llmAvailability': {
                        setLLMButton(message.payload);
                        break;
                    }
                    case 'exportError':
                        // VSC will show the error message
                        break;

                }
            });


            // Enhanced error handling for different environments
            function initializeMermaid() {
                try {
                    mermaid.initialize({
                        startOnLoad: true,
                        theme: '${theme}',
                        securityLevel: 'loose',
                        flowchart: {
                            useMaxWidth: false,
                            htmlLabels: true,
                            curve: 'basis'
                        }
                    });
                } catch (error) {
                    console.warn('Mermaid initialization error:', error);
                    // Try with more basic configuration for compatibility
                    try {
                        mermaid.initialize({
                            startOnLoad: true,
                            theme: '${theme}',
                            securityLevel: 'loose'
                        });
                    } catch (fallbackError) {
                        console.error('Mermaid fallback initialization failed:', fallbackError);
                    }
                }
            }

            // Initialize mermaid with error handling
            if (typeof mermaid !== 'undefined') {
                initializeMermaid();
            } else {
                console.error('Mermaid library not loaded');
            }

            function setupInteractions(svgElement) {
                if (!svgElement) return;

                const panZoomInstance = svgPanZoom(svgElement, {
                    zoomEnabled: true,
                    controlIconsEnabled: true,
                    fit: true,
                    center: true,
                    minZoom: 0.1,
                    maxZoom: 10,
                    zoomScaleSensitivity: 0.2,
                    onZoom: function() {
                        notifyWebviewInteractionStart();
                        notifyWebviewInteractionEnd();
                    },
                    onPan: function() {
                        notifyWebviewInteractionStart();
                        notifyWebviewInteractionEnd();
                    }
                });

                // Track mouse interactions for panning/dragging
                let isMouseDown = false;
                let isDragging = false;
                svgElement.addEventListener('mousedown', (e) => {
                    // Only track if not clicking on a node (nodes have their own click handlers)
                    if (!e.target.closest('.node')) {
                        isMouseDown = true;
                        notifyWebviewInteractionStart();
                    }
                });
                svgElement.addEventListener('mousemove', (e) => {
                    if (isMouseDown) {
                        isDragging = true;
                    }
                });
                svgElement.addEventListener('mouseup', () => {
                    if (isMouseDown) {
                        isMouseDown = false;
                        notifyWebviewInteractionEnd();
                        isDragging = false;
                    }
                });
                svgElement.addEventListener('mouseleave', () => {
                    if (isMouseDown) {
                        isMouseDown = false;
                        isDragging = false;
                        notifyWebviewInteractionEnd();
                    }
                });

                // Parse edge metadata from mermaid source comments
                function parseEdgeMetadata() {
                    const mermaidSource = document.getElementById('mermaid-source').textContent;
                    const edgeMetadata = new Map();
                    
                    const lines = mermaidSource.split('\\n');
                    for (const line of lines) {
                        const match = line.match(/%% EDGE_META:([^:]+):([^:]+)/);
                        if (match) {
                            const [, source, target] = match;
                            if (!edgeMetadata.has(source)) {
                                edgeMetadata.set(source, []);
                            }
                            edgeMetadata.get(source).push(target);
                        }
                    }
                    return edgeMetadata;
                }

                function extractBaseId(fullNodeId) {
                    if (!fullNodeId) return '';
                    // Remove flowchart prefix and suffix numbers
                    let base = fullNodeId.startsWith('flowchart-') 
                        ? fullNodeId.replace(/^flowchart-/, '') 
                        : fullNodeId;
                    base = base.replace(/-[\\d-]+$/, '');
                    return base;
                }

                function findOutgoingEdges(fullNodeId, edgeMetadata) {
                    const baseId = extractBaseId(fullNodeId);
                    if (!baseId) return [];

                    const outgoingEdges = [];
                    const targets = edgeMetadata.get(baseId) || [];
                    
                    // Look for edges with IDs that contain the source->target relationship
                    for (const target of targets) {
                        const edgePatterns = [
                            "L_" + baseId + "_" + target + "_",
                            baseId + "_" + target,
                            baseId + "-" + target,
                            "edge_" + baseId + "_" + target
                        ];
                        
                        for (const pattern of edgePatterns) {
                            const matchingEdge = document.querySelector('[id*="' + pattern + '"]');
                            if (matchingEdge) {
                                outgoingEdges.push(matchingEdge);
                                break;
                            }
                        }
                    }
                    return outgoingEdges;
                }

                function findConnectedNodes(baseId, edgeMetadata) {
                    const targets = edgeMetadata.get(baseId) || [];
                    const connectedNodes = [];
                    
                    for (const targetBaseId of targets) {
                        // Try multiple patterns to find target nodes
                        const patterns = [
                            '[id*="' + targetBaseId + '"]',
                            '#flowchart-' + targetBaseId + '-',
                            '[id^="flowchart-' + targetBaseId + '"]'
                        ];
                        
                        for (const pattern of patterns) {
                            const targetNode = document.querySelector(pattern);
                            if (targetNode && !connectedNodes.includes(targetNode)) {
                                connectedNodes.push(targetNode);
                                break;
                            }
                        }
                    }
                    return connectedNodes;
                }

                // Parse edge metadata once
                const edgeMetadata = parseEdgeMetadata();

                const allNodes = svgElement.querySelectorAll('.node');
                allNodes.forEach((node) => {
                    const fullNodeId = node.id;
                    if (!fullNodeId) return;
                    const baseId = extractBaseId(fullNodeId);
                    const loc = NODE_LOCATIONS[baseId];

                    if (loc && node.getAttribute('data-codevisualizer-click-ready') !== 'true') {
                        node.setAttribute('data-codevisualizer-click-ready', 'true');
                        node.addEventListener('click', (event) => {
                            const target = event.target;
                            if (target && typeof target.closest === 'function' && target.closest('.drill-icon')) {
                                return;
                            }
                            if (Date.now() < suppressNodeClickUntil) {
                                return;
                            }

                            event.preventDefault();
                            event.stopPropagation();
                            notifyWebviewInteractionStart();
                            vscode.postMessage({
                                command: 'highlightCode',
                                payload: { start: loc.start, end: loc.end }
                            });
                            notifyWebviewInteractionEnd();
                        });
                    }

                    node.addEventListener('mouseenter', (event) => {
                        event.stopPropagation();
                        node.classList.add('hover-highlight');

                        const outgoingEdges = findOutgoingEdges(fullNodeId, edgeMetadata);
                        outgoingEdges.forEach(edge => {
                            edge.classList.add('hover-highlight');
                        });

                        const connectedNodes = findConnectedNodes(baseId, edgeMetadata);
                        connectedNodes.forEach(connectedNode => {
                            connectedNode.classList.add('child-highlight');
                        });
                    });

                    node.addEventListener('mouseleave', () => {
                        document.querySelectorAll('.hover-highlight, .child-highlight').forEach(el => {
                            el.classList.remove('hover-highlight', 'child-highlight');
                        });
                    });
                });

                addDrillInIcons(svgElement, extractBaseId);
            }

            /**
             * Adds a small clickable "drill in" icon to every node that represents a
             * function/method call, so the user can jump straight to that callee's
             * own flowchart instead of just highlighting the call site.
             */
            function addDrillInIcons(svgElement, extractBaseId) {
                if (!CALL_NODES || Object.keys(CALL_NODES).length === 0) return;
                const svgNS = 'http://www.w3.org/2000/svg';

                svgElement.querySelectorAll('.node').forEach((node) => {
                    if (node.querySelector('.drill-icon')) return; // avoid duplicates on re-render
                    const baseId = extractBaseId(node.id);
                    const loc = CALL_NODES[baseId];
                    if (!loc) return;

                    let bbox;
                    try {
                        bbox = node.getBBox();
                    } catch {
                        return;
                    }

                    const size = 22;
                    const iconGroup = document.createElementNS(svgNS, 'g');
                    iconGroup.setAttribute('class', 'drill-icon');
                    iconGroup.setAttribute(
                        'transform',
                        'translate(' + (bbox.x + bbox.width - size - 4) + ',' + (bbox.y + 4) + ')'
                    );

                    const title = document.createElementNS(svgNS, 'title');
                    title.textContent = 'View code flow inside this function';
                    iconGroup.appendChild(title);

                    const circle = document.createElementNS(svgNS, 'circle');
                    circle.setAttribute('class', 'drill-icon-bg');
                    circle.setAttribute('cx', String(size / 2));
                    circle.setAttribute('cy', String(size / 2));
                    circle.setAttribute('r', String(size / 2));
                    iconGroup.appendChild(circle);

                    const glyph = document.createElementNS(svgNS, 'text');
                    glyph.setAttribute('class', 'drill-icon-glyph');
                    glyph.setAttribute('x', String(size / 2));
                    glyph.setAttribute('y', String(size / 2 + 5));
                    glyph.setAttribute('text-anchor', 'middle');
                    glyph.textContent = '\u{1F50E}';
                    iconGroup.appendChild(glyph);

                    function suppressParentNodeClick(event) {
                        suppressNodeClickUntil = Date.now() + 750;
                        event.preventDefault();
                        event.stopPropagation();
                        if (typeof event.stopImmediatePropagation === 'function') {
                            event.stopImmediatePropagation();
                        }
                    }

                    ['pointerdown', 'mousedown', 'mouseup', 'dblclick'].forEach((eventName) => {
                        iconGroup.addEventListener(eventName, suppressParentNodeClick, true);
                    });

                    iconGroup.addEventListener('click', (event) => {
                        suppressParentNodeClick(event);
                        notifyWebviewInteractionStart();
                        event.stopPropagation();
                        vscode.postMessage({
                            command: 'drillIntoFunction',
                            payload: { start: loc.start, end: loc.end }
                        });
                        notifyWebviewInteractionEnd();
                    });

                    node.appendChild(iconGroup);
                });
            }

            window.addEventListener('load', () => {
                setTimeout(() => {
                    const svgElement = document.querySelector('.mermaid svg');
                    if (svgElement) {
                        setupInteractions(svgElement);
                    } else {
                        console.error('[CodeVisualizer] SVG element for flowchart not found after initial load!');
                    }
                }, 200);

            });

            // Track user interaction for button clicks
            let buttonInteractionTimeout = null;
            function notifyButtonInteractionStart() {
                vscode.postMessage({ command: 'userInteractionStart', payload: {} });
                if (buttonInteractionTimeout) {
                    clearTimeout(buttonInteractionTimeout);
                }
            }
            function notifyButtonInteractionEnd() {
                if (buttonInteractionTimeout) {
                    clearTimeout(buttonInteractionTimeout);
                }
                // Delay end notification to avoid flickering during rapid interactions
                buttonInteractionTimeout = setTimeout(() => {
                    vscode.postMessage({ command: 'userInteractionEnd', payload: {} });
                }, 300);
            }

            function setupButtonHandlers() {
                const copyBtn = document.getElementById('copy-mermaid');
                if (copyBtn) {
                    copyBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        const source = document.getElementById('mermaid-source').textContent;
                        vscode.postMessage({ command: 'copyMermaid', payload: { code: source } });
                        notifyButtonInteractionEnd();
                    });
                }
                const exportSvgBtn = document.getElementById('export-svg');
                if(exportSvgBtn) {
                    exportSvgBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        exportFlowchart('svg').finally(() => notifyButtonInteractionEnd());
                    });
                }
                
                const exportPngBtn = document.getElementById('export-png');
                if(exportPngBtn) {
                    exportPngBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        exportFlowchart('png').finally(() => notifyButtonInteractionEnd());
                    });
                }

                const openPanelBtn = document.getElementById('open-panel-btn');
                if (openPanelBtn) {
                    openPanelBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        vscode.postMessage({ command: 'openInPanel', payload: {} });
                        notifyButtonInteractionEnd();
                    });
                }

                // Metrics toggle functionality
                const metricsToggle = document.getElementById('metrics-toggle');
                const metricsPanel = document.getElementById('metrics-panel');
                if (metricsToggle && metricsPanel) {
                    let isMetricsHidden = false;
                    
                    function updateMetricsToggleState() {
                        if (isMetricsHidden) {
                            metricsPanel.classList.add('hidden');
                            metricsToggle.textContent = 'Metrics';
                            metricsToggle.title = 'Show metrics display';
                        } else {
                            metricsPanel.classList.remove('hidden');
                            metricsToggle.textContent = 'Metrics';
                            metricsToggle.title = 'Hide metrics display';
                        }
                    }
                    
                    updateMetricsToggleState(); // Set initial state
                    
                    metricsToggle.addEventListener('click', () => {
                        isMetricsHidden = !isMetricsHidden;
                        updateMetricsToggleState();
                    });
                }

            }
            setupButtonHandlers();

            /**
             * Handles exporting the flowchart to SVG or PNG.
             * It generates a clean SVG from the source to ensure no UI controls are included.
             */
            async function exportFlowchart(fileType) {
                try {
                    const mermaidSourceElement = document.getElementById('mermaid-source');
                    if (!mermaidSourceElement || !mermaidSourceElement.textContent) {
                        throw new Error("Could not find Mermaid source code to export.");
                    }

                    const mermaidSource = mermaidSourceElement.textContent
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&')
                        .trim();
                    
                    const { svg } = await mermaid.render('export-svg-element', mermaidSource);
                    
                    const parser = new DOMParser();
                    const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
                    const cleanSvgElement = svgDoc.documentElement;

                    if (!cleanSvgElement || cleanSvgElement.tagName !== 'svg') {
                        throw new Error('Invalid SVG generated by Mermaid render');
                    }

                    // Temporarily add to DOM to calculate size
                    const tempDiv = document.createElement('div');
                    tempDiv.style.position = 'absolute';
                    tempDiv.style.visibility = 'hidden';
                    document.body.appendChild(tempDiv);
                    tempDiv.appendChild(cleanSvgElement);
                    const bbox = cleanSvgElement.getBBox();
                    document.body.removeChild(tempDiv);

                    const padding = 20;
                    const finalX = bbox.x - padding;
                    const finalY = bbox.y - padding;
                    const finalWidth = bbox.width + (padding * 2);
                    const finalHeight = bbox.height + (padding * 2);

                    cleanSvgElement.setAttribute('width', finalWidth.toString());
                    cleanSvgElement.setAttribute('height', finalHeight.toString());
                    cleanSvgElement.setAttribute('viewBox', \`\${finalX} \${finalY} \${finalWidth} \${finalHeight}\`);

                    const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim() || '#ffffff';
                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('x', finalX.toString());
                    rect.setAttribute('y', finalY.toString());
                    rect.setAttribute('width', finalWidth.toString());
                    rect.setAttribute('height', finalHeight.toString());
                    rect.setAttribute('fill', backgroundColor);
                    cleanSvgElement.insertBefore(rect, cleanSvgElement.firstChild);

                    const finalSvgData = new XMLSerializer().serializeToString(cleanSvgElement);

                    if (fileType === 'svg') {
                        vscode.postMessage({
                            command: 'export',
                            payload: { fileType: 'svg', data: finalSvgData }
                        });
                    } else if (fileType === 'png') {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            throw new Error("Could not get canvas 2D context.");
                        }

                        const scale = 2; // For higher DPI
                        canvas.width = finalWidth * scale;
                        canvas.height = finalHeight * scale;
                        ctx.scale(scale, scale);

                        const img = new Image();
                        img.onload = function() {
                            ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
                            const pngData = canvas.toDataURL('image/png').split(',')[1];
                            vscode.postMessage({
                                command: 'export',
                                payload: { fileType: 'png', data: pngData }
                            });
                        };
                        img.onerror = function() {
                            throw new Error("SVG to PNG conversion failed (image load error).");
                        };
                        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(finalSvgData);
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown export error';
                    vscode.postMessage({
                        command: 'exportError',
                        payload: { error: 'Export failed: ' + errorMessage }
                    });
                }
            }

            // LLM toggle functionality
            const llmToggle = document.getElementById('llm-toggle');
            function setLLMButton(availability) {
                if (!llmToggle) return;
                if (!availability || !availability.enabled) {
                    llmToggle.textContent = 'Enable LLM';
                    llmToggle.title = 'Enable LLM labels (configure provider and API key)';
                    llmToggle.onclick = () => {
                        notifyButtonInteractionStart();
                        vscode.postMessage({ command: 'setupLLM', payload: {} });
                        notifyButtonInteractionEnd();
                    };
                    return;
                }
                isLLMEnabled = localStorage.getItem('codevisualizer-llm-enabled') === 'true';
                llmToggle.textContent = isLLMEnabled ? '✓ LLM' : 'LLM';
                llmToggle.title = isLLMEnabled ? 'Disable LLM labels' : 'Enable LLM labels';

                llmToggle.onclick = () => {
                    notifyButtonInteractionStart();
                    if (isLLMEnabled) {
                        vscode.postMessage({ command: 'disableLLMLabels', payload: {} });
                    } else {
                        // Optimistically show progress
                        llmToggle.setAttribute('disabled', 'true');
                        llmToggle.textContent = '…';
                        vscode.postMessage({ command: 'requestLLMLabels', payload: {} });
                        // Re-enable after a short delay; final state will be set upon successful applyMermaid
                        setTimeout(() => llmToggle.removeAttribute('disabled'), 2000);
                    }
                    notifyButtonInteractionEnd();
                };
            }
            setLLMButton(INITIAL_LLM);

            // Auto-apply LLM labels if previously enabled and available
            try {
                const persistedLLM = localStorage.getItem('codevisualizer-llm-enabled') === 'true';
                if (INITIAL_LLM && INITIAL_LLM.enabled && persistedLLM) {
                    isLLMEnabled = true;
                    // Defer the request slightly to allow initial render to complete
                    setTimeout(() => {
                        vscode.postMessage({ command: 'requestLLMLabels', payload: {} });
                    }, 200);
                }
            } catch (err) {
                console.warn('[CodeVisualizer] Unable to read LLM persisted state:', err);
            }
        </script>
    </body>
    </html>`;
}

  /**
   * Helper to generate CSS for controls to keep getWebviewContent cleaner.
   */
  private getStylesForControls(context: any): string {
      return `
        #panel-controls {
            position: fixed; top: 10px; left: 10px; right: 10px; z-index: 1000;
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 16px; background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border); border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        #export-controls {
            position: ${context.isPanel ? "relative" : "absolute"};
            ${context.isPanel ? "" : "top: 10px; right: 10px;"}
            z-index: 1000; display: flex; gap: 10px;
        }
        #export-controls button, #open-panel-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 5px 10px; cursor: pointer; border-radius: 4px; font-size: 11px;
        }
        #export-controls button:hover, #open-panel-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        /* LLM toggle */
        #llm-toggle {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 6px 10px; cursor: pointer; border-radius: 4px; font-size: 11px;
        }
        #llm-toggle[disabled] { opacity: 0.6; cursor: default; }

        /* Metrics panel */
        #metrics-container {
            position: fixed;
            ${context.isPanel ? "top: 80px;" : "top: 50px;"}
            right: 10px;
            z-index: 1001;
            display: flex;
            align-items: flex-start;
            gap: 8px;
        }

        #metrics-panel {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 6px;
            padding: 10px 12px;
            font-size: 12px;
            color: var(--vscode-editor-foreground);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            min-width: 200px;
            max-width: 280px;
        }

        #metrics-panel.hidden {
            display: none;
        }

        #metrics-panel-title {
            font-weight: 600;
            margin-bottom: 8px;
            font-size: 13px;
            color: var(--vscode-textLink-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 4px;
        }

        .metrics-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .metrics-item:last-child {
            border-bottom: none;
        }

        .metrics-label {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }

        .metrics-value {
            font-weight: 600;
            color: var(--vscode-editor-foreground);
            font-size: 12px;
        }

        #metrics-toggle {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 6px 10px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 11px;
            flex-shrink: 0;
        }

        #metrics-toggle:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

      `;
  }

  /**
   * Helper to generate HTML for controls.
   */
  private getHtmlForControls(context: any, codeMetrics?: CodeMetrics): string {
    // Metrics toggle button - goes in the toolbar
    const metricsToggleButton = codeMetrics ? `
                <button id="metrics-toggle" title="Toggle metrics display">📈</button>
    ` : '';
    
    // Metrics panel - stays in original position
    const metricsPanel = codeMetrics ? `
        <div id="metrics-container">
            <div id="metrics-panel">
                <div id="metrics-panel-title">Code Metrics</div>
                <div class="metrics-item">
                    <span class="metrics-label">Lines of Code:</span>
                    <span class="metrics-value">${codeMetrics.linesOfCode}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Nodes:</span>
                    <span class="metrics-value">${codeMetrics.numberOfNodes}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Edges/Branches:</span>
                    <span class="metrics-value">${codeMetrics.numberOfEdges}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Decision Points:</span>
                    <span class="metrics-value">${codeMetrics.decisionPoints}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Return Statements:</span>
                    <span class="metrics-value">${codeMetrics.returnStatements}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Parameters:</span>
                    <span class="metrics-value">${codeMetrics.functionParameters}</span>
                </div>
            </div>
        </div>
    ` : '';

    const panelControls = `
        <div id="panel-controls">
            <div>Flowchart Viewer</div>
            <div id="export-controls">
                <button id="copy-mermaid" title="Copy Mermaid Code">Copy Code</button>
                <button id="export-svg" title="Export as SVG">SVG</button>
                <button id="export-png" title="Export as PNG">PNG</button>
                ${metricsToggleButton}
                <button id="llm-toggle" title="Toggle human-friendly labels"></button>
            </div>
        </div>
        ${metricsPanel}
    `;

    const sidebarControls = `
        <div id="export-controls">
            ${context.showPanelButton ? '<button id="open-panel-btn">Open in New Window</button>' : ''}
            <button id="copy-mermaid" title="Copy Mermaid Code">Copy Code</button>
            <button id="export-svg">Export as SVG</button>
            <button id="export-png">Export as PNG</button>
            ${metricsToggleButton}
            <button id="llm-toggle" title="Toggle human-friendly labels"></button>
        </div>
        ${metricsPanel}
    `;
    
    return context.isPanel ? panelControls : sidebarControls;
  }

  /**
   * Generates a simple HTML page to show a loading or informational message.
   */
  protected getLoadingHtml(message: string): string {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body, html {
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100%;
                    width: 100%;
                    margin: 0;
                    padding: 0;
                }
            </style>
        </head>
        <body>
            <p>${message}</p>
        </body>
        </html>`;
  }

  /**
   * Generates a random nonce for Content Security Policy.
   */
  protected getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Cleans up disposables when the provider is disposed.
   */
  public dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._currentDocument = undefined;
    this._currentPosition = undefined;
    this._isUpdating = false;
    this._locationMap = [];
    this._currentFunctionRange = undefined;
    this._eventListenersSetup = false;

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
