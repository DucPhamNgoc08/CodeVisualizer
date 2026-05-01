import * as vscode from "vscode";
import { initPythonLanguageService } from "./python";
import { initTypeScriptLanguageService } from "./typescript";
import { initJavaLanguageService } from "./java";
import { initCppLanguageService } from "./cpp";
import { initCLanguageService } from "./c";
import { initRustLanguageService } from "./rust";
import { EnvironmentDetector } from "../utils/EnvironmentDetector";
import { initGoLanguageService } from "./go";
import { initPhpLanguageService } from "./php";

/**
 * Initializes all language services for the extension.
 */
export async function initLanguageServices(context: vscode.ExtensionContext) {
  const env = EnvironmentDetector.detectEnvironment();
  const isCompatibilityMode = env.requiresCompatibilityMode;
  
  const services = [
    {
      name: "Python",
      init: async () => {
        const pythonWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-python.wasm"
        ).fsPath;
        await initPythonLanguageService(pythonWasmPath);
      },
    },
    {
      name: "TypeScript",
      init: async () => {
        const typescriptWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-typescript.wasm"
        ).fsPath;
        await initTypeScriptLanguageService(typescriptWasmPath);
      },
    },
    {
      name: "Java",
      init: async () => {
        const javaWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-java.wasm"
        ).fsPath;
        await initJavaLanguageService(javaWasmPath);
      },
    },
    {
      name: "C++",
      init: async () => {
        const cppWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-cpp.wasm"
        ).fsPath;
        await initCppLanguageService(cppWasmPath);
      },
    },
    {
      name: "C",
      init: async () => {
        const cWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-c.wasm"
        ).fsPath;
        await initCLanguageService(cWasmPath);
      },
    },
    {
      name: "Rust",
      init: async () => {
        const rustWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-rust.wasm"
        ).fsPath;
        await initRustLanguageService(rustWasmPath);
      },
    },
    {
      name: "Go",
      init: async () => {
        const goWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-go.wasm"
        ).fsPath;
        await initGoLanguageService(goWasmPath);
      },
    },
    {
      name: "PHP",
      init: async () => {
        const phpWasmPath = vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tree-sitter-php.wasm"
        ).fsPath;
        await initPhpLanguageService(phpWasmPath);
      },
    },
  ];

  let successfullyInitialized = 0;
  const errors: string[] = [];

  for (const service of services) {
    try {
      console.log(`Initializing ${service.name} language service...`);
      
      if (isCompatibilityMode) {
        // Add a small delay between services in compatibility mode
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      await service.init();
      console.log(`${service.name} language service initialized successfully`);
      successfullyInitialized++;
    } catch (error) {
      const errorMessage = `Failed to initialize ${service.name} language service: ${error}`;
      console.error(errorMessage);
      errors.push(errorMessage);
      
      if (isCompatibilityMode) {
        // In compatibility mode, continue with other services instead of failing completely
        console.warn(`Continuing initialization in compatibility mode despite ${service.name} failure`);
      } else {
        // In regular VS Code, throw immediately as before
        throw new Error(errorMessage);
      }
    }
  }

  if (isCompatibilityMode && errors.length > 0) {
    const failedServices = services.length - successfullyInitialized;
    const message = `CodeVisualizer: ${successfullyInitialized} of ${services.length} language services initialized successfully. ${failedServices} services failed in compatibility mode.`;
    console.warn(message);
    
    if (successfullyInitialized === 0) {
      throw new Error("No language services could be initialized");
    } else {
      // Show a warning but don't fail completely
      vscode.window.showWarningMessage(`CodeVisualizer: Some language services failed to initialize in ${env.editor}. Core functionality will work for successfully loaded languages.`);
    }
  }
}
