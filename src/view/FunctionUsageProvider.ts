import * as vscode from "vscode";
import { CallGraphAnalyzer } from "../core/callgraph/CallGraphAnalyzer";
import {
  CallGraphMermaidGenerator,
  CallGraphNodeLocation,
} from "../core/callgraph/CallGraphMermaidGenerator";
import { EnvironmentDetector } from "../core/utils/EnvironmentDetector";
import { FunctionFlowPopupProvider } from "./FunctionFlowPopupProvider";

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
  private _codeFlowPopup: FunctionFlowPopupProvider | undefined;

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
          } else if (message.command === "viewCodeFlow") {
            await this.viewCodeFlow(message.payload);
          }
        },
        null,
        this._disposables
      );

      // Pop the usage graph out into its own OS window so it can be kept
      // visible (e.g. on a second monitor) while you keep coding.
      setTimeout(() => {
        vscode.commands
          .executeCommand("workbench.action.moveEditorToNewWindow")
          .then(undefined, (error) => {
            console.warn("Could not move function usage panel to new window:", error);
          });
      }, 100);
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

  /**
   * Opens a standalone popup showing this caller's own code flow, so the
   * user can see what's inside it instead of just jumping to its source.
   */
  private async viewCodeFlow(payload: CallGraphNodeLocation): Promise<void> {
    if (!payload || !payload.file) {
      return;
    }
    try {
      const uri = vscode.Uri.file(payload.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const start = doc.positionAt(payload.start);
      const end = doc.positionAt(payload.end);

      const popup = this.getCodeFlowPopup();
      const viewColumn = popup.viewColumn ?? this.revealPanelForChildPopup();
      await popup.showFor(uri, new vscode.Range(start, end), viewColumn);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Could not open code flow: ${message}`);
    }
  }

  private getCodeFlowPopup(): FunctionFlowPopupProvider {
    if (!this._codeFlowPopup || !this._codeFlowPopup.hasPanel) {
      this._codeFlowPopup = new FunctionFlowPopupProvider(this._extensionUri);
    }
    return this._codeFlowPopup;
  }

  private revealPanelForChildPopup(): vscode.ViewColumn {
    if (!this._panel) {
      return vscode.ViewColumn.Active;
    }

    const viewColumn = this._panel.viewColumn ?? vscode.ViewColumn.Active;
    this._panel.reveal(viewColumn, false);
    return this._panel.viewColumn ?? viewColumn;
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

            /* Drill-in icon shown on each caller node */
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
        </style>
    </head>
    <body>
        <div id="header">
            <strong>Usage of ${this.escapeHtml(targetName)}</strong> — ${this.escapeHtml(summary)}${truncatedNote}
            <span style="opacity:0.7"> · Click a node to jump to its definition, or the 🔎 icon to view its code flow.</span>
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
                const panZoomInstance = svgPanZoom(svgElement, {
                    zoomEnabled: true, controlIconsEnabled: true, fit: true, center: true,
                    minZoom: 0.1, maxZoom: 50, zoomScaleSensitivity: 0.2
                });

                // Re-fit the diagram whenever the panel/window is resized (e.g. moved to
                // another monitor and maximized) — svg-pan-zoom caches viewport size at
                // init time and won't otherwise notice the container changed.
                let resizeTimeout;
                window.addEventListener('resize', () => {
                    clearTimeout(resizeTimeout);
                    resizeTimeout = setTimeout(() => {
                        panZoomInstance.resize();
                        panZoomInstance.fit();
                        panZoomInstance.center();
                    }, 100);
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
                        addDrillInIcon(node, loc);
                    }
                });
            }

            /**
             * Adds a small clickable icon to a caller node so the user can view that
             * function's own code flow diagram instead of just jumping to its source.
             */
            function addDrillInIcon(node, loc) {
                if (node.querySelector('.drill-icon')) return;
                const svgNS = 'http://www.w3.org/2000/svg';

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

                iconGroup.addEventListener('click', (event) => {
                    event.stopPropagation();
                    vscode.postMessage({ command: 'viewCodeFlow', payload: loc });
                });

                node.appendChild(iconGroup);
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
    if (this._codeFlowPopup) {
      this._codeFlowPopup.dispose();
      this._codeFlowPopup = undefined;
    }
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}
