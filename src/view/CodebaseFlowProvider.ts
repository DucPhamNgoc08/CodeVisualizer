import * as vscode from "vscode";
import * as path from "path";
import { CodebaseAnalyzer } from "../core/dependency/CodebaseAnalyzer";
import { CodebaseGraphBuilder } from "../core/dependency/CodebaseGraphBuilder";
import { EnvironmentDetector } from "../core/utils/EnvironmentDetector";

const MERMAID_VERSION = "11.8.0";
const SVG_PAN_ZOOM_VERSION = "3.6.1";

/**
 * Provider for visualizing entire codebase flow (inspired by dependency-cruiser)
 */
export class CodebaseFlowProvider {
  private _panel: vscode.WebviewPanel | undefined;
  private _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  /**
   * Create or show the codebase flow panel
   */
  public async createOrShow(
    viewColumn: vscode.ViewColumn,
    selectedPaths?: string[]
  ): Promise<void> {
    // If panel already exists, just reveal it
    if (this._panel) {
      this._panel.reveal(viewColumn);
      return;
    }

    // Create new panel
    this._panel = vscode.window.createWebviewPanel(
      "codevisualizer.codebaseFlow",
      "📦 Codebase Flow",
      viewColumn,
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true,
      }
    );
    
    this._panel.onDidDispose(
      () => {
        this._panel = undefined;
      },
      null,
      this._disposables
    );

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "refresh":
            await this.updateView(selectedPaths);
            break;
        }
      },
      null,
      this._disposables
    );

    // Initial update
    await this.updateView(selectedPaths);
  }

  /**
   * Update the webview content
   */
  private async updateView(selectedPaths?: string[]): Promise<void> {
    if (!this._panel) {
      return;
    }

    const webview = this._panel.webview;

    // Show loading
    webview.html = this.getLoadingHtml("Analyzing codebase...");

    try {
      // Get workspace root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        webview.html = this.getLoadingHtml("No workspace folder found.");
        return;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;

      // Analyze codebase with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Analyzing codebase...",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: "Scanning files..." });

          const analyzer = new CodebaseAnalyzer(workspaceRoot);
          const modules = await analyzer.analyzeCodebase(selectedPaths);

          progress.report({ increment: 50, message: "Building graph..." });

          const builder = new CodebaseGraphBuilder(modules, workspaceRoot);
          const mermaidCode = builder.generateMermaid();

          progress.report({ increment: 100, message: "Complete!" });

          // Update webview
          webview.html = this.getWebviewContent(mermaidCode, webview);
        }
      );
    } catch (error) {
      console.error("Codebase analysis failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";
      webview.html = this.getLoadingHtml(`Error: ${errorMessage}`);
    }
  }

  private getWebviewContent(mermaidCode: string, webview: vscode.Webview): string {
    const nonce = this.getNonce();
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? "dark"
        : "default";

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${EnvironmentDetector.getContentSecurityPolicy(nonce)}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Codebase Flow</title>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js"></script>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@${SVG_PAN_ZOOM_VERSION}/dist/svg-pan-zoom.min.js"></script>
        <style>
            body, html {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
            }
            #container {
                width: 100%;
                height: calc(100% - 80px);
                margin-top: 60px;
                overflow: hidden;
                position: relative;
            }
            .mermaid { 
                width: 100%; 
                height: 100%; 
                display: block;
                position: relative;
            }
            .mermaid svg { 
                width: 100% !important;
                height: 100% !important;
                display: block;
            }
            #controls {
                position: fixed;
                top: 10px;
                left: 10px;
                right: 10px;
                z-index: 1000;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 16px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            }
            #controls button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: 1px solid var(--vscode-button-border, transparent);
                padding: 6px 12px;
                cursor: pointer;
                border-radius: 4px;
                font-size: 12px;
                margin-left: 8px;
            }
            #controls button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            
            /* Override node fill colors to use VSCode theme */
            /* Core style - use subtle green tint */
            .mermaid .coreStyle > rect,
            .mermaid .coreStyle > polygon,
            .mermaid .coreStyle > path {
                fill: var(--vscode-editor-background) !important;
                stroke: #00AA00 !important;
                stroke-width: 2px !important;
            }
            
            /* Report style - use subtle pink tint */
            .mermaid .reportStyle > rect,
            .mermaid .reportStyle > polygon,
            .mermaid .reportStyle > path {
                fill: var(--vscode-editor-background) !important;
                stroke: #CC00CC !important;
                stroke-width: 2px !important;
            }
            
            /* Config style - use subtle blue tint */
            .mermaid .configStyle > rect,
            .mermaid .configStyle > polygon,
            .mermaid .configStyle > path {
                fill: var(--vscode-editor-background) !important;
                stroke: #0066FF !important;
                stroke-width: 2px !important;
            }
            
            /* Tool style - use subtle orange tint */
            .mermaid .toolStyle > rect,
            .mermaid .toolStyle > polygon,
            .mermaid .toolStyle > path {
                fill: var(--vscode-editor-background) !important;
                stroke: #FF6600 !important;
                stroke-width: 2px !important;
            }
            
            /* Entry style - use subtle grey */
            .mermaid .entryStyle > rect,
            .mermaid .entryStyle > polygon,
            .mermaid .entryStyle > path {
                fill: var(--vscode-editor-background) !important;
                stroke: #666666 !important;
                stroke-width: 2px !important;
            }
            
            /* Node text color */
            .mermaid .coreStyle text,
            .mermaid .reportStyle text,
            .mermaid .configStyle text,
            .mermaid .toolStyle text,
            .mermaid .entryStyle text {
                fill: var(--vscode-editor-foreground) !important;
            }
            
            /* Subgraph/cluster styling */
            .mermaid .cluster rect,
            .mermaid .cluster polygon {
                fill: var(--vscode-editor-background) !important;
                stroke: var(--vscode-panel-border) !important;
                stroke-width: 2px !important;
            }
            
            .mermaid .cluster text {
                fill: var(--vscode-editor-foreground) !important;
            }
        </style>
    </head>
    <body>
        <div id="controls">
            <div><strong>Codebase Flow Visualization</strong></div>
            <div>
                <button id="refresh-btn" title="Refresh analysis">Refresh</button>
                <button id="export-svg" title="Export as SVG">SVG</button>
                <button id="export-png" title="Export as PNG">PNG</button>
            </div>
        </div>
        <div id="container">
            <div class="mermaid">${mermaidCode.replace(/<\/script>/gi, '<\\/script>')}</div>
        </div>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();

            function initializeMermaid() {
                try {
                    mermaid.initialize({
                        startOnLoad: true,
                        theme: '${theme}',
                        securityLevel: 'loose',
                        maxTextSize: 500000,
                        flowchart: {
                            useMaxWidth: false,
                            htmlLabels: true,
                            curve: 'basis',
                            padding: 20
                        }
                    });
                } catch (error) {
                    console.warn('Mermaid initialization error:', error);
                }
            }

            function setupInteractions(svgElement) {
                if (!svgElement) return;

                // Ensure SVG fills container
                const container = document.getElementById('container');
                if (container && svgElement) {
                    // Get SVG's natural dimensions from viewBox or bbox
                    const viewBox = svgElement.getAttribute('viewBox');
                    let svgWidth, svgHeight;
                    
                    if (viewBox) {
                        const parts = viewBox.split(' ');
                        svgWidth = parseFloat(parts[2]);
                        svgHeight = parseFloat(parts[3]);
                    } else {
                        const bbox = svgElement.getBBox();
                        svgWidth = bbox.width;
                        svgHeight = bbox.height;
                    }
                    
                    // Set SVG to fill container but preserve aspect ratio
                    const containerWidth = container.clientWidth;
                    const containerHeight = container.clientHeight;
                    
                    // Calculate scale to fill container
                    const scaleX = containerWidth / svgWidth;
                    const scaleY = containerHeight / svgHeight;
                    const initialScale = Math.min(scaleX, scaleY) * 0.9; // 90% to leave some margin
                    
                    // Set SVG dimensions
                    svgElement.setAttribute('width', svgWidth);
                    svgElement.setAttribute('height', svgHeight);
                    svgElement.style.width = svgWidth + 'px';
                    svgElement.style.height = svgHeight + 'px';
                }

                const panZoomInstance = svgPanZoom(svgElement, {
                    zoomEnabled: true,
                    controlIconsEnabled: true,
                    fit: true,
                    center: true,
                    minZoom: 0.1,
                    maxZoom: 100,
                    zoomScaleSensitivity: 0.1
                });

                console.log('Codebase flow diagram rendered successfully with pan/zoom');
            }

            // Initialize mermaid
            if (typeof mermaid !== 'undefined') {
                initializeMermaid();
            } else {
                console.error('Mermaid library not loaded');
            }

            // Wait for SVG to render, then setup interactions
            window.addEventListener('load', () => {
                setTimeout(() => {
                    const svgElement = document.querySelector('.mermaid svg');
                    if (svgElement) {
                        setupInteractions(svgElement);
                    } else {
                        // Retry if SVG not ready yet
                        let attempts = 0;
                        const maxAttempts = 20;
                        const checkAndSetup = () => {
                            const svg = document.querySelector('.mermaid svg');
                            if (svg) {
                                setupInteractions(svg);
                            } else if (attempts < maxAttempts) {
                                attempts++;
                                setTimeout(checkAndSetup, 100);
                            } else {
                                console.error('Mermaid SVG not found after initialization');
                            }
                        };
                        checkAndSetup();
                    }
                }, 200);
            });

            // Button handlers
            document.getElementById('refresh-btn')?.addEventListener('click', () => {
                vscode.postMessage({ command: 'refresh' });
            });

            document.getElementById('export-svg')?.addEventListener('click', async () => {
                const svgElement = document.querySelector('.mermaid svg');
                if (svgElement) {
                    const svgData = new XMLSerializer().serializeToString(svgElement);
                    const blob = new Blob([svgData], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'codebase-flow.svg';
                    a.click();
                    URL.revokeObjectURL(url);
                }
            });

            document.getElementById('export-png')?.addEventListener('click', async () => {
                const svgElement = document.querySelector('.mermaid svg');
                if (svgElement) {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const svgData = new XMLSerializer().serializeToString(svgElement);
                    const img = new Image();
                    img.onload = () => {
                        canvas.width = img.width;
                        canvas.height = img.height;
                        ctx?.drawImage(img, 0, 0);
                        canvas.toBlob((blob) => {
                            if (blob) {
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'codebase-flow.png';
                                a.click();
                                URL.revokeObjectURL(url);
                            }
                        });
                    };
                    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
                }
            });
        </script>
    </body>
    </html>`;
  }

  /**
   * Get loading HTML
   */
  private getLoadingHtml(message: string): string {
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
   * Escape HTML special characters in Mermaid code
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Generate random nonce
   */
  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    if (this._panel) {
      this._panel.dispose();
    }
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}

