import * as vscode from "vscode";
import { FlowchartViewProvider } from "./view/FlowchartViewProvider";
import { FlowchartPanelProvider } from "./view/FlowchartPanelProvider";
import { initLanguageServices } from "./logic/language-services";
import { LLMManager } from "./logic/llm/LLMManager";
import { setExtensionContext } from "./logic/llm/LLMContext";
import { EnvironmentDetector } from "./logic/utils/EnvironmentDetector";

export async function activate(context: vscode.ExtensionContext) {
  console.log("CodeVisualizer extension is now active!");
  setExtensionContext(context);

  // Detect environment and log compatibility mode
  const env = EnvironmentDetector.detectEnvironment();
  if (env.requiresCompatibilityMode) {
    console.log(`CodeVisualizer: Running in compatibility mode for ${env.editor}`);
    vscode.window.showInformationMessage(`CodeVisualizer: Detected ${env.editor} editor - running in compatibility mode`);
  }

  try {
    // Initialize all language services
    await initLanguageServices(context);
    console.log("All language parsers initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize language parsers:", error);
    vscode.window.showErrorMessage(
      "CodeVisualizer: Failed to load language parsers. Flowchart generation may not be available."
    );
  }

  // Register sidebar provider
  const sidebarProvider = new FlowchartViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      FlowchartViewProvider.viewType,
      sidebarProvider
    )
  );

  // Register panel commands
  context.subscriptions.push(
    vscode.commands.registerCommand("codevisualizer.openFlowchartInPanel", async () => {
      console.log("Command codevisualizer.openFlowchartInPanel executed");
      try {
        // Close sidebar view to avoid duplication
        await FlowchartPanelProvider.closeSidebarView();

        const panelProvider = FlowchartPanelProvider.getInstance(
          context.extensionUri
        );
        panelProvider.createOrShow(vscode.ViewColumn.Two, true); // Move to new window
      } catch (error) {
        console.error("Error in openFlowchartInPanel:", error);
        vscode.window.showErrorMessage(`Failed to open flowchart panel: ${error}`);
      }
    }),

    vscode.commands.registerCommand("codevisualizer.openFlowchartToSide", async () => {
      console.log("Command codevisualizer.openFlowchartToSide executed");
      try {
        // Close sidebar view to avoid duplication
        await FlowchartPanelProvider.closeSidebarView();

        const panelProvider = FlowchartPanelProvider.getInstance(
          context.extensionUri
        );
        panelProvider.createOrShow(vscode.ViewColumn.Beside, false); // Keep in same window but beside
      } catch (error) {
        console.error("Error in openFlowchartToSide:", error);
        vscode.window.showErrorMessage(`Failed to open flowchart to side: ${error}`);
      }
    }),

    vscode.commands.registerCommand(
      "codevisualizer.openFlowchartInNewColumn",
      async () => {
        console.log("Command codevisualizer.openFlowchartInNewColumn executed");
        try {
          // Close sidebar view to avoid duplication
          await FlowchartPanelProvider.closeSidebarView();

          const panelProvider = FlowchartPanelProvider.getInstance(
            context.extensionUri
          );
          panelProvider.createOrShow(vscode.ViewColumn.Three, false);
        } catch (error) {
          console.error("Error in openFlowchartInNewColumn:", error);
          vscode.window.showErrorMessage(`Failed to open flowchart in new column: ${error}`);
        }
      }
    ),

    vscode.commands.registerCommand(
      "codevisualizer.maximizeFlowchartPanel",
      async () => {
        console.log("Command codevisualizer.maximizeFlowchartPanel executed");
        try {
          // Close sidebar view to avoid duplication
          await FlowchartPanelProvider.closeSidebarView();

          const panelProvider = FlowchartPanelProvider.getInstance(
            context.extensionUri
          );
          // Open in the active column to effectively "maximize" it
          panelProvider.createOrShow(vscode.ViewColumn.Active, false);
        } catch (error) {
          console.error("Error in maximizeFlowchartPanel:", error);
          vscode.window.showErrorMessage(`Failed to maximize flowchart panel: ${error}`);
        }
      }
    ),

    // Add a specific command for opening in new window
    vscode.commands.registerCommand(
      "codevisualizer.openFlowchartInNewWindow",
      async () => {
        console.log("Command codevisualizer.openFlowchartInNewWindow executed");
        try {
          // Close sidebar view to avoid duplication
          await FlowchartPanelProvider.closeSidebarView();

          const panelProvider = FlowchartPanelProvider.getInstance(
            context.extensionUri
          );
          panelProvider.createOrShow(vscode.ViewColumn.Two, true); // Explicitly move to new window
        } catch (error) {
          console.error("Error in openFlowchartInNewWindow:", error);
          vscode.window.showErrorMessage(`Failed to open flowchart in new window: ${error}`);
        }
      }
    ),

    vscode.commands.registerCommand("codevisualizer.generateFlowchart", () => {
      console.log("Command codevisualizer.generateFlowchart executed");
      try {
        // Force update both sidebar and panel if they exist
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          sidebarProvider.refresh();

          const panelProvider = FlowchartPanelProvider.getInstance(
            context.extensionUri
          );
          if (panelProvider.isVisible()) {
            panelProvider.refresh();
          }
        } else {
          vscode.window.showWarningMessage("Please open a file to generate a flowchart.");
        }
      } catch (error) {
        console.error("Error in generateFlowchart:", error);
        vscode.window.showErrorMessage(`Failed to generate flowchart: ${error}`);
      }
    }),

    vscode.commands.registerCommand("codevisualizer.refreshFlowchart", () => {
      console.log("Command codevisualizer.refreshFlowchart executed");
      try {
        sidebarProvider.refresh();
        const panelProvider = FlowchartPanelProvider.getInstance(
          context.extensionUri
        );
        if (panelProvider.isVisible()) {
          panelProvider.refresh();
        }
      } catch (error) {
        console.error("Error in refreshFlowchart:", error);
        vscode.window.showErrorMessage(`Failed to refresh flowchart: ${error}`);
      }
    }),

    vscode.commands.registerCommand("codevisualizer.exportFlowchart", async () => {
      console.log("Command codevisualizer.exportFlowchart executed");
      vscode.window.showInformationMessage("Export flowchart feature coming soon!");
    }),

    // LLM: Enable labels (provider+key flow)
    vscode.commands.registerCommand("codevisualizer.llm.enableLabels", async () => {
      console.log("Command codevisualizer.llm.enableLabels executed");
      try {
        await LLMManager.enableLLM(context);
      } catch (error) {
        console.error("Error in enableLabels:", error);
        vscode.window.showErrorMessage(`Failed to enable LLM labels: ${error}`);
      }
    }),

    // LLM: Change model
    vscode.commands.registerCommand("codevisualizer.llm.changeModel", async () => {
      console.log("Command codevisualizer.llm.changeModel executed");
      try {
        await LLMManager.changeModel(context);
      } catch (error) {
        console.error("Error in changeModel:", error);
        vscode.window.showErrorMessage(`Failed to change model: ${error}`);
      }
    }),

    //LLM: Reset cache
    vscode.commands.registerCommand("codevisualizer.llm.resetCache", async () => {
      console.log("Command codevisualizer.llm.resetCache executed");
      try {
        await LLMManager.resetCache(context);
      } catch (error) {
        console.error("Error in resetCache:", error);
        vscode.window.showErrorMessage(`Failed to reset cache: ${error}`);
      }
    })
  );
}

export function deactivate() {
  FlowchartPanelProvider.reset();
}
