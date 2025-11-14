import * as vscode from "vscode";

/**
 * Utility class to detect the VS Code-based editor environment
 * and handle compatibility differences between VS Code, Cursor, and Windsurf
 */
export class EnvironmentDetector {
  private static _detectionResult: EditorEnvironment | null = null;

  /**
   * Detect which VS Code-based editor is running
   */
  public static detectEnvironment(): EditorEnvironment {
    if (this._detectionResult) {
      return this._detectionResult;
    }

    const appName = vscode.env.appName?.toLowerCase() || "";
    const appHost = vscode.env.appHost?.toLowerCase() || "";
    const userAgent =
      (globalThis as any)?.navigator?.userAgent?.toLowerCase() || "";
    const cwd = process.env.VSCODE_CWD?.toLowerCase() || "";
    const portable = process.env.VSCODE_PORTABLE?.toLowerCase() || "";

    type EditorType = "vscode" | "cursor" | "windsurf" | "trae" | "unknown";
    const editorConfigs: { id: EditorType; keywords: string[] }[] = [
      { id: "cursor", keywords: ["cursor"] },
      { id: "windsurf", keywords: ["windsurf"] },
      { id: "trae", keywords: ["trae"] },
      { id: "vscode", keywords: ["visual studio code", "vscode"] },
    ];

    let editor: EditorType = "unknown";
    const sources = [appName, appHost, userAgent, cwd, portable];
    for (const cfg of editorConfigs) {
      if (sources.some((src) => cfg.keywords.some((k) => src.includes(k)))) {
        editor = cfg.id;
        break;
      }
    }

    this._detectionResult = {
      editor,
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      isVSCode: editor === "vscode",
      isCursor: editor === "cursor",
      isWindsurf: editor === "windsurf",
      isTrae: editor === "trae",
      requiresCompatibilityMode:
        editor === "cursor" || editor === "windsurf" || editor === "trae",
    };

    console.log("Environment detected:", this._detectionResult);
    return this._detectionResult;
  }

  /**
   * Get specific webview options based on the detected environment
   */
  public static getWebviewOptions(
    baseOptions: vscode.WebviewOptions
  ): vscode.WebviewOptions {
    const env = this.detectEnvironment();

    const options = { ...baseOptions };

    if (env.requiresCompatibilityMode) {
      // For Cursor/Windsurf, be more conservative with webview options
      options.enableCommandUris = true; // Explicitly enable command URIs
      options.enableForms = false; // Disable forms to avoid issues

      // Ensure local resource roots are properly set
      if (!options.localResourceRoots) {
        options.localResourceRoots = [];
      }
    }

    return options;
  }

  /**
   * Get Content Security Policy adjusted for the environment
   */
  public static getContentSecurityPolicy(nonce: string): string {
    const env = this.detectEnvironment();

    // Base CSP that should work in all environments
    // Allow d3js.org for D3.js library
    let csp = `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net https://d3js.org https://d3js.org/; style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src https://cdn.jsdelivr.net;`;

    if (env.requiresCompatibilityMode) {
      // For Cursor/Windsurf, add more permissive policies for compatibility
      csp = `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net https://d3js.org https://d3js.org/ 'unsafe-eval'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https: blob:; font-src https://cdn.jsdelivr.net data:; connect-src https: wss: ws:;`;
    }

    return csp;
  }

  /**
   * Get webview panel options adjusted for the environment
   */
  public static getWebviewPanelOptions(
    baseOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions
  ): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    const env = this.detectEnvironment();
    const options = { ...baseOptions };

    if (env.requiresCompatibilityMode) {
      // For Cursor/Windsurf, adjust panel behavior
      options.retainContextWhenHidden = true; // Always retain context for stability
      options.enableFindWidget = true; // Ensure find widget is enabled
    }

    return this.getWebviewOptions(options);
  }

  /**
   * Check if we need to apply compatibility workarounds
   */
  public static needsCompatibilityMode(): boolean {
    return this.detectEnvironment().requiresCompatibilityMode;
  }

  /**
   * Get environment-specific initialization delay
   */
  public static getInitializationDelay(): number {
    const env = this.detectEnvironment();

    // Cursor and Windsurf might need slightly longer initialization times
    return env.requiresCompatibilityMode ? 100 : 0;
  }
}

export interface EditorEnvironment {
  editor: "vscode" | "cursor" | "windsurf" | "trae" | "unknown";
  appName: string;
  appHost: string;
  isVSCode: boolean;
  isCursor: boolean;
  isWindsurf: boolean;
  isTrae: boolean;
  requiresCompatibilityMode: boolean;
}
