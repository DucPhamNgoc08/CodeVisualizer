import * as vscode from "vscode";
import { EnvironmentDetector } from "../core/utils/EnvironmentDetector";
import {
  BaseFlowchartProvider,
  FlowchartViewContext,
  WebviewMessage,
} from "./BaseFlowchartProvider";

/**
 * Shows a single function's code flow as a standalone popup panel, without
 * tracking the active editor. Used for "drill in" actions (from a
 * function-call node in the main flowchart, or a caller node in the Function
 * Usage graph) so exploring a callee never disturbs the view you drilled in
 * from. Each call opens a new, independent panel, and drilling further from
 * within a popup opens another one on top.
 */
export class FunctionFlowPopupProvider extends BaseFlowchartProvider {
  private _panel: vscode.WebviewPanel | undefined;

  constructor(extensionUri: vscode.Uri) {
    super(extensionUri);
  }

  protected getWebview(): vscode.Webview | undefined {
    return this._panel?.webview;
  }

  protected setWebviewHtml(html: string): void {
    if (this._panel) {
      this._panel.webview.html = html;
    }
  }

  protected getViewContext(): FlowchartViewContext {
    return {
      isPanel: true,
      showPanelButton: false,
    };
  }

  public get hasPanel(): boolean {
    return this._panel !== undefined;
  }

  public get viewColumn(): vscode.ViewColumn | undefined {
    return this._panel?.viewColumn;
  }

  /** Renders the flowchart for the function containing `range` in `uri`. */
  public async showFor(
    uri: vscode.Uri,
    range: vscode.Range,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active
  ): Promise<void> {
    if (this._panel) {
      this._panel.reveal(this._panel.viewColumn ?? viewColumn);
    } else {
      const baseOptions = {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
        retainContextWhenHidden: true,
      };
      this._panel = vscode.window.createWebviewPanel(
        "codevisualizer.functionFlowPopup",
        "Code Flow",
        viewColumn,
        EnvironmentDetector.getWebviewPanelOptions(baseOptions)
      );

      this._panel.onDidDispose(
        () => {
          this._panel = undefined;
          this.dispose();
        },
        null,
        this._disposables
      );

      this._panel.webview.onDidReceiveMessage(
        (message: WebviewMessage) => this.handleWebviewMessage(message),
        null,
        this._disposables
      );
    }

    this.setWebviewHtml(this.getLoadingHtml("Generating code flow..."));

    try {
      const doc = await vscode.workspace.openTextDocument(uri);

      const fileName = doc.fileName.split(/[\\/]/).pop() || "function";
      this._panel.title = `Code Flow — ${fileName}`;

      await this.updateViewForDocument(doc, range.start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setWebviewHtml(this.getLoadingHtml(`Error: ${message}`));
    }
  }

  public dispose(): void {
    if (this._panel) {
      this._panel.dispose();
      this._panel = undefined;
    }
    super.dispose();
  }
}
