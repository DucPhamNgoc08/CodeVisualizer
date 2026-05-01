import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FlowchartIR, FlowchartNode, FlowchartEdge, NodeType, NodeCategory } from "../../ir/ir";
import { FileCategory, FileTypeClassifier } from "./FileTypeClassifier";

export interface CodebaseModule{
  source: string; // Absolute path to file
  relativePath: string; // Relative path from workspace root
  fileName: string; // Just the filename
  languageId: string;
  fileCategory: FileCategory; // File category for color coding
  dependencies: CodebaseDependency[]; // Files this module imports/requires
  dependents: string[]; // Files that import/require this module
  functions: string[]; // Functions defined in this file
  exports: string[]; // Exported functions/classes
}

export interface CodebaseDependency{
  module: string; // Import path as written in code
  resolved: string | null; // Resolved absolute path (null if not resolvable)
  dependencyTypes: string[]; // e.g., "import", "require", "dynamic"
  valid: boolean; // Whether the dependency could be resolved
}

export class CodebaseAnalyzer {
  private workspaceRoot: string;
  private modules: Map<string, CodebaseModule> = new Map();
  private supportedExtensions: Set<string> = new Set([
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".java", ".cpp", ".c", ".h", ".hpp",
    ".rs", ".go", ".php"
  ]);

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  public async analyzeCodebase(
    selectedPaths?: string[]
  ): Promise<Map<string, CodebaseModule>> {
    this.modules.clear();

    // Get files to analyze
    const filesToAnalyze = selectedPaths 
      ? await this.getFilesFromPaths(selectedPaths)
      : await this.getAllSupportedFiles();

    // Analyze each file
    for (const filePath of filesToAnalyze) {
      try {
        const module = await this.analyzeFile(filePath);
        if (module) {
          this.modules.set(module.source, module);
        }
      } catch (error) {
        console.error(`Error analyzing ${filePath}:`, error);
      }
    }

    // Resolve dependencies and build dependency graph
    this.resolveDependencies();

    return this.modules;
  }

  private async getAllSupportedFiles(): Promise<string[]> {
    const files: string[] = [];

    const walkDir = async (dir: string): Promise<void> => {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          // Skip node_modules, .git, dist, build, etc.
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "build" ||
            entry.name === ".git"
          ) {
            continue;
          }

          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (this.supportedExtensions.has(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch (error) {
      }
    };

    await walkDir(this.workspaceRoot);
    return files;
  }

  private async getFilesFromPaths(selectedPaths: string[]): Promise<string[]> {
    const files: string[] = [];

    for (const selectedPath of selectedPaths) {
      const stat = await fs.promises.stat(selectedPath);
      
      if (stat.isFile()) {
        files.push(selectedPath);
      } else if (stat.isDirectory()) {
        const dirFiles = await this.getAllSupportedFiles();
        // Filter files that are within the selected directory
        const relativePath = path.relative(this.workspaceRoot, selectedPath);
        const filtered = dirFiles.filter(file => {
          const fileRelative = path.relative(selectedPath, file);
          return !fileRelative.startsWith("..") && !path.isAbsolute(fileRelative);
        });
        files.push(...filtered);
      }
    }

    return [...new Set(files)]; // Remove duplicates
  }

  private async analyzeFile(filePath: string): Promise<CodebaseModule | null> {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const relativePath = path.relative(this.workspaceRoot, filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath);
      const languageId = this.getLanguageId(ext);

      // Extract dependencies based on language
      const dependencies = this.extractDependencies(content, filePath, languageId);
      // Extract functions (simplified - could be enhanced)
      const functions = this.extractFunctions(content, languageId);
      // Extract exports
      const exports = this.extractExports(content, languageId);
      // Classify file category for color coding
      const fileCategory = FileTypeClassifier.classifyFile(relativePath, fileName);

      return {
        source: filePath,
        relativePath,
        fileName,
        languageId,
        fileCategory,
        dependencies,
        dependents: [], // Will be filled in resolveDependencies
        functions,
        exports,
      };
    } catch (error){
      console.error(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  private extractDependencies(
    content: string,
    filePath: string,
    languageId: string
  ): CodebaseDependency[] {
    const dependencies: CodebaseDependency[] = [];

    if (languageId === "typescript" || languageId === "javascript") {
      // Extract ES6 imports
      const importRegex = /import\s+(?:(?:\*\s+as\s+\w+)|(?:\{[^}]*\})|(?:\w+))\s+from\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const modulePath = match[1];
        const resolved = this.resolveModulePath(modulePath, filePath);
        dependencies.push({
          module: modulePath,
          resolved,
          dependencyTypes: ["import"],
          valid: resolved !== null,
        });
      }

      // Extract require() calls
      const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        const modulePath = match[1];
        const resolved = this.resolveModulePath(modulePath, filePath);
        dependencies.push({
          module: modulePath,
          resolved,
          dependencyTypes: ["require"],
          valid: resolved !== null,
        });
      }
    } else if (languageId === "python") {
      const importRegex = /(?:^|\n)\s*(?:import|from)\s+(\S+)/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const modulePath = match[1].split(" ")[0].split(".")[0];
        const resolved = this.resolvePythonModule(modulePath, filePath);
        dependencies.push({
          module: modulePath,
          resolved,
          dependencyTypes: ["import"],
          valid: resolved !== null,
        });
      }
    } else if (languageId === "php") {
      const includeRegex = /\b(?:require|require_once|include|include_once)\s*(?:\(?\s*)[^;]*?['"]([^'"]+)['"]/g;
      let match;
      while ((match = includeRegex.exec(content)) !== null) {
        const modulePath = match[1];
        const resolved = this.resolveModulePath(modulePath, filePath);
        dependencies.push({
          module: modulePath,
          resolved,
          dependencyTypes: ["include"],
          valid: resolved !== null,
        });
      }
    }

    return dependencies;
  }

  private resolveModulePath(modulePath: string, fromFile: string): string | null {
    if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) {
      return null; // External dependency
    }

    const fromDir = path.dirname(fromFile);
    let resolved: string;

    try {
      if (modulePath.startsWith("/")) {
        // Absolute path from workspace root
        resolved = path.join(this.workspaceRoot, modulePath);
      } else {
        // Relative path
        resolved = path.resolve(fromDir, modulePath);
      }

      // Try different extensions
      const extensions = ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".php"];
      for (const ext of extensions) {
        const withExt = resolved + ext;
        if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
          return withExt;
        }
      }

      // Try as directory with index file
      const indexExtensions = ["index.js", "index.ts", "index.jsx", "index.tsx", "index.php"];
      for (const indexExt of indexExtensions) {
        const indexPath = path.join(resolved, indexExt);
        if (fs.existsSync(indexPath)) {
          return indexPath;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private resolvePythonModule(modulePath: string, fromFile: string): string | null {
    // Skip standard library
    if (!modulePath.includes("/") && !modulePath.includes("\\")) {
      return null;
    }

    const fromDir = path.dirname(fromFile);
    let resolved: string;

    try {
      if (modulePath.startsWith(".")) {
        resolved = path.resolve(fromDir, modulePath.replace(/\./g, path.sep));
      } else {
        resolved = path.resolve(this.workspaceRoot, modulePath.replace(/\./g, path.sep));
      }

      // Try .py extension
      const withExt = resolved + ".py";
      if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
        return withExt;
      }

      // Try as directory with __init__.py
      const initPath = path.join(resolved, "__init__.py");
      if (fs.existsSync(initPath)) {
        return initPath;
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractFunctions(content: string, languageId: string): string[] {
    const functions: string[] = [];

    if (languageId === "typescript" || languageId === "javascript") {
      // Function declarations
      const funcDeclRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
      let match;
      while ((match = funcDeclRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }

      // Arrow functions assigned to variables
      const arrowFuncRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]\s*(?:async\s*)?\(/g;
      while ((match = arrowFuncRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }

      // Class methods
      const methodRegex = /(?:public\s+|private\s+|protected\s+)?(\w+)\s*\(/g;
      while ((match = methodRegex.exec(content)) !== null) {
        if (!functions.includes(match[1])) {
          functions.push(match[1]);
        }
      }
    } else if (languageId === "python") {
      const funcRegex = /def\s+(\w+)\s*\(/g;
      let match;
      while ((match = funcRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }
    } else if (languageId === "php") {
      const funcRegex = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let match;
      while ((match = funcRegex.exec(content)) !== null) {
        functions.push(match[1]);
      }
    }

    return functions;
  }

  private extractExports(content: string, languageId: string): string[] {
    const exports: string[] = [];

    if (languageId === "typescript" || languageId === "javascript") {
      // export function/const/class
      const exportRegex = /export\s+(?:function|const|let|class|async\s+function)\s+(\w+)/g;
      let match;
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
    } else if (languageId === "python") {
      // __all__ or explicit exports (simplified)
      const allRegex = /__all__\s*=\s*\[([^\]]+)\]/;
      const match = content.match(allRegex);
      if (match) {
        const items = match[1].split(",").map(s => s.trim().replace(/['"]/g, ""));
        exports.push(...items);
      }
    } else if (languageId === "php") {
      const publicSymbolRegex = /(?:class|interface|trait|enum|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      let match;
      while ((match = publicSymbolRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
    }

    return exports;
  }

  private resolveDependencies(): void {
    // Build dependents map (reverse of dependencies)
    for (const [source, module] of this.modules.entries()) {
      for (const dep of module.dependencies) {
        if (dep.resolved && this.modules.has(dep.resolved)) {
          const dependentModule = this.modules.get(dep.resolved)!;
          if (!dependentModule.dependents.includes(source)) {
            dependentModule.dependents.push(source);
          }
        }
      }
    }
  }

  private getLanguageId(ext: string): string {
    const langMap: Record<string, string> = {
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".ts": "typescript",
      ".tsx": "typescript",
      ".py": "python",
      ".java": "java",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".cc": "cpp",
      ".c": "c",
      ".h": "c",
      ".hpp": "cpp",
      ".rs": "rust",
      ".go": "go",
      ".php": "php",
    };
    return langMap[ext] || "unknown";
  }

  public getModules(): Map<string, CodebaseModule> {
    return this.modules;
  }
}

