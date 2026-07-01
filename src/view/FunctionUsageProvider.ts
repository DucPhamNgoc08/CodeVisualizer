import * as vscode from "vscode";
import { CallGraphAnalyzer } from "../core/callgraph/CallGraphAnalyzer";
import {
  CallGraphMermaidGenerator,
  CallGraphNodeLocation,
} from "../core/callgraph/CallGraphMermaidGenerator";
import { EnvironmentDetector } from "../core/utils/EnvironmentDetector";

const MERMAID_VERSION = "11.8.0";
const SVG_PAN_ZOOM_VERSION = "3.6.1";

/**
 * Shows a reverse call (usage) graph for a single function: every function
 * that calls it, recursively up the call chain. Nodes are clickable and jump
 * to the corresponding definition.
 */
export class FunctionUsageProvider {
  private _panel: vscode.WebviewPanel | undefined;
  private _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _locations: Record<string, CallGraphNodeLocation> = {};

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  public async show(
    targetName: string,
    targetFile: string,
    targetPosition: number,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside
  ): Promise<void> {
    if (!this._panel) {
      const baseOptions = {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true,
      };
      this._panel = vscode.window.createWebviewPanel(
        "codevisualizer.functionUsage",
        `Usage: ${targetName}`,
        viewColumn,
        EnvironmentDetector.getWebviewPanelOptions(baseOptions)
      );

      this._panel.onDidDispose(
        () => {
          this._panel = undefined;
        },
        null,
        this._disposables
      );

      this._panel.webview.onDidReceiveMessage(
        async (message) => {
          if (message.command === "openFunction") {
            await this.openFunction(message.payload);
          }
        },
        null,
        this._disposables
      );
    } else {
      this._panel.title = `Usage: ${targetName}`;
      this._panel.reveal(viewColumn);
    }

    const webview = this._panel.webview;
    webview.html = this.getLoadingHtml(`Analyzing usage of "${targetName}"...`);

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        webview.html = this.getLoadingHtml("No workspace folder found.");
        return;
      }
      const workspaceRoot = workspaceFolders[0].uri.fsPath;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Finding usages of "${targetName}"...`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: "Scanning files..." });

          const analyzer = new CallGraphAnalyzer(workspaceRoot);
          await analyzer.analyze();

          progress.report({ increment: 60, message: "Building call graph..." });

          const graph = analyzer.buildUsageGraph(
            targetName,
            targetFile,
            targetPosition
          );

          const { mermaid, locations } = new CallGraphMermaidGenerator().generate(
            graph
          );
          this._locations = locations;

          progress.report({ increment: 100, message: "Complete!" });

          const callerCount = graph.nodes.filter((n) => !n.isTarget).length;
          webview.html = this.getWebviewContent(
            mermaid,
            webview,
            targetName,
            callerCount,
            graph.truncated
          );
        }
      );
    } catch (error) {
      console.error("Function usage analysis failed:", error);
      const message =
        error instanceof Error ? error.message : "An unknown error occurred";
      webview.html = this.getLoadingHtml(`Error: ${message}`);
    }
  }

  private async openFunction(payload: CallGraphNodeLocation): Promise<void> {
    if (!payload || !payload.file) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(payload.file)
      );
      const editor = await vscode.window.showTextDocument(
        doc,
        vscode.ViewColumn.One
      );
      const start = doc.positionAt(payload.start);
      const end = doc.positionAt(payload.end);
      const range = new vscode.Range(start, end);
      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Could not open function: ${message}`);
    }
  }

  private getWebviewContent(
    mermaidCode: string,
    webview: vscode.Webview,
    targetName: string,
    callerCount: number,
    truncated: boolean
  ): string {
    const nonce = this.getNonce();
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? "dark"
        : "default";

    const summary =
      callerCount === 0
        ? `No callers found for "${targetName}" in this workspace.`
        : `${callerCount} function${callerCount === 1 ? "" : "s"} (directly or transitively) call "${targetName}".`;
    const truncatedNote = truncated
      ? ' <span style="opacity:0.8">(graph truncated — too many callers)</span>'
      : "";

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${EnvironmentDetector.getContentSecurityPolicy(nonce)}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Function Usage</title>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js"></script>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@${SVG_PAN_ZOOM_VERSION}/dist/svg-pan-zoom.min.js"></script>
        <style>
            body, html {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
            }
            #header {
                position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
                padding: 10px 16px; background: var(--vscode-editor-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                font-size: 12px;
            }
            #header strong { color: var(--vscode-textLink-foreground); }
            #container {
                width: 100%; height: calc(100% - 48px); margin-top: 48px;
                overflow: hidden; position: relative;
            }
            .mermaid { width: 100%; height: 100%; display: block; }
            .mermaid svg { width: 100% !important; height: 100% !important; display: block; }
            .mermaid .node { cursor: pointer; }
            .mermaid .node.hovered > * {
                filter: drop-shadow(0 0 6px var(--vscode-textLink-foreground));
            }
            #mermaid-source { display: none; }
        </style>
    </head>
    <body>
        <div id="header">
            <strong>Usage of ${this.escapeHtml(targetName)}</strong> — ${this.escapeHtml(summary)}${truncatedNote}
            <span style="opacity:0.7"> · Click a node to jump to its definition.</span>
        </div>
        <div id="container">
            <div class="mermaid">${mermaidCode.replace(/<\/script>/gi, "<\\/script>")}</div>
        </div>
        <div id="mermaid-source">${mermaidCode.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            const LOCATIONS = ${JSON.stringify(this._locations)};

            mermaid.initialize({
                startOnLoad: true,
                theme: '${theme}',
                securityLevel: 'loose',
                maxTextSize: 500000,
                flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis', padding: 20 }
            });

            function extractBaseId(domId) {
                if (!domId) return '';
                let base = domId.startsWith('flowchart-') ? domId.slice('flowchart-'.length) : domId;
                return base.replace(/-\\d+$/, '');
            }

            function setupInteractions(svgElement) {
                if (!svgElement) return;
                svgPanZoom(svgElement, {
                    zoomEnabled: true, controlIconsEnabled: true, fit: true, center: true,
                    minZoom: 0.1, maxZoom: 50, zoomScaleSensitivity: 0.2
                });

                svgElement.querySelectorAll('.node').forEach((node) => {
                    const baseId = extractBaseId(node.id);
                    const loc = LOCATIONS[baseId];
                    node.addEventListener('mouseenter', () => node.classList.add('hovered'));
                    node.addEventListener('mouseleave', () => node.classList.remove('hovered'));
                    if (loc) {
                        node.addEventListener('click', () => {
                            vscode.postMessage({ command: 'openFunction', payload: loc });
                        });
                    }
                });
            }

            window.addEventListener('load', () => {
                let attempts = 0;
                const trySetup = () => {
                    const svg = document.querySelector('.mermaid svg');
                    if (svg) {
                        setupInteractions(svg);
                    } else if (attempts++ < 20) {
                        setTimeout(trySetup, 100);
                    }
                };
                setTimeout(trySetup, 200);
            });
        </script>
    </body>
    </html>`;
  }

  private getLoadingHtml(message: string): string {
    return `<!DOCTYPE html>
    <html lang="en"><head><meta charset="UTF-8">
    <style>
        body, html { background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            display: flex; justify-content: center; align-items: center;
            height: 100%; width: 100%; margin: 0; padding: 0; }
    </style></head>
    <body><p>${this.escapeHtml(message)}</p></body></html>`;
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  public dispose(): void {
    if (this._panel) {
      this._panel.dispose();
    }
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}
