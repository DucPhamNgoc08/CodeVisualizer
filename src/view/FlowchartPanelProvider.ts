import * as vscode from "vscode";
import { EnvironmentDetector } from "../core/utils/EnvironmentDetector";
import {
  BaseFlowchartProvider,
  WebviewMessage,
  FlowchartViewContext,
} from "./BaseFlowchartProvider";

export class FlowchartPanelProvider extends BaseFlowchartProvider {
  private _panel?: vscode.WebviewPanel;
  private static _instance?: FlowchartPanelProvider;

  public static getInstance(extensionUri: vscode.Uri): FlowchartPanelProvider {
    if (!FlowchartPanelProvider._instance) {
      FlowchartPanelProvider._instance = new FlowchartPanelProvider(
        extensionUri
      );
    }
    return FlowchartPanelProvider._instance;
  }

  public static reset(): void {
    if (FlowchartPanelProvider._instance) {
      FlowchartPanelProvider._instance.dispose();
      FlowchartPanelProvider._instance = undefined;
    }
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


  public createOrShow(
    viewColumn?: vscode.ViewColumn,
    moveToNewWindow: boolean = false
  ): void {
    if (this._panel) {
      this._panel.reveal(viewColumn);
      if (moveToNewWindow) {
        this.moveToNewWindow();
      }
      this.forceUpdateView(vscode.window.activeTextEditor);
      return;
    }
    const config = vscode.workspace.getConfiguration("codevisualizer");
    const defaultPosition = config.get<string>("panel.defaultPosition", "two");
    const retainWhenHidden = config.get<boolean>(
      "panel.retainWhenHidden",
      true
    );
    const enableFindWidget = config.get<boolean>(
      "panel.enableFindWidget",
      true
    );

    const getViewColumn = (position: string): vscode.ViewColumn => {
      switch (position) {
        case "beside":
          return vscode.ViewColumn.Beside;
        case "three":
          return vscode.ViewColumn.Three;
        case "two":
        default:
          return vscode.ViewColumn.Two;
      }
    };

    const finalViewColumn = viewColumn || getViewColumn(defaultPosition);


    const baseOptions = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
      retainContextWhenHidden: retainWhenHidden,
      enableFindWidget: enableFindWidget,

      enableCommandUris: true,
    };
    
    this._panel = vscode.window.createWebviewPanel(
      "codevisualizer.flowchartPanel",
      "🔍 Flowchart Viewer", 
      finalViewColumn,
      EnvironmentDetector.getWebviewPanelOptions(baseOptions)
    );

    // Set a distinctive icon to make it stand out
    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, "media", "icon.svg"),
      dark: vscode.Uri.joinPath(this._extensionUri, "media", "icon.svg"),
    };

    this._panel.onDidDispose(
      () => {
        this._panel = undefined;
        // Reset the singleton instance when panel is disposed
        FlowchartPanelProvider._instance = undefined;
      },
      null,
      this._disposables
    );

    this._panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) {
          this.updateTitle();
          setTimeout(() => {
            this.forceUpdateView(vscode.window.activeTextEditor);
          }, 50);
        }
      },
      null,
      this._disposables
    );

    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleWebviewMessage(message),
      null,
      this._disposables
    );

    this.setupEventListeners();

    this.updateView(vscode.window.activeTextEditor);

    if (moveToNewWindow) {
      // Use setTimeout to ensure the panel is fully created before moving
      setTimeout(() => {
        this.moveToNewWindow();
      }, 100);
    }

    const message = moveToNewWindow
      ? "Flowchart opened in new window! Use Cmd+W to close or drag to reposition."
      : "Flowchart opened in detachable panel! You can drag this tab to split views or different positions.";

    vscode.window.showInformationMessage(message, "Got it");
  }

  public isVisible(): boolean {
    return this._panel?.visible ?? false;
  }

  private async moveToNewWindow(): Promise<void> {
    if (!this._panel) {
      return;
    }

    try {
      await vscode.commands.executeCommand(
        "workbench.action.moveEditorToNewWindow"
      );
    } catch (error) {
      console.warn("Could not move panel to new window:", error);
      // Fallback: show notification with manual instructions
      vscode.window.showInformationMessage(
        "To move to a separate window: Right-click the tab → 'Move into New Window' or drag the tab out of VS Code",
        "Got it"
      );
    }
  }

  public static async closeSidebarView(): Promise<void> {
    try {

      console.log("Attempting to close sidebar view");
    } catch (error) {
      console.warn("Could not close sidebar view:", error);
    }
  }

  public updateTitle(fileName?: string): void {
    if (this._panel) {
      const title = fileName
        ? `Code Flowchart - ${fileName}`
        : "Code Flowchart";
      this._panel.title = title;
    }
  }

  public async updateView(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    if (editor) {
      const fileName =
        editor.document.fileName.split("/").pop() ||
        editor.document.fileName.split("\\").pop() ||
        "Untitled";
      this.updateTitle(fileName);
    } else {
      this.updateTitle();
    }

    await super.updateView(editor);
  }

  public refresh(): void {
    if (this._panel) {
      this.forceUpdateView(vscode.window.activeTextEditor);
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
