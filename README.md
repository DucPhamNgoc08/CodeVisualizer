# CodeVisualizer

**Real-time interactive flowcharts and dependency visualization for your code with AI-powered insights**

CodeVisualizer is a powerful VS Code extension that provides two main visualization capabilities: function-level flowcharts for understanding code control flow, and codebase-level dependency graphs for analyzing project structure and module relationships.

![CodeVisualizer](https://img.shields.io/badge/version-1.0.1-blue.svg)
![VS Code](https://img.shields.io/badge/VS%20Code-1.105.0+-green.svg)
![License](https://img.shields.io/badge/license-MIT-orange.svg)




https://github.com/user-attachments/assets/60b544ed-5149-4b79-b187-35325a3c41fe


https://github.com/user-attachments/assets/b323bbc8-5c1d-4865-aa12-3235706a33fc



## Main Features

### 1. Function-Level Flowchart Generation

Transform individual functions into interactive, visual flowcharts to understand control flow, decision points, and execution paths.

**Supported Languages:**
- Python
- TypeScript/JavaScript
- Java
- C++
- C
- Rust
- Go

**Capabilities:**
- **Multi-language Support**: Parse and visualize functions across 7 programming languages
- **Interactive Visualization**: Click nodes to navigate to code, zoom and pan
- **Multiple Views**: Sidebar view and detachable panel windows
- **Semantic Analysis**: Understand control flow, loops, exceptions, and async operations
- **Export Options**: Export flowcharts as PNG, SVG, or PDF (coming soon)

### 2. Codebase Dependency Visualization

Analyze and visualize the entire codebase structure, showing module dependencies, file relationships, and project architecture.

**Supported Languages:**
- TypeScript/JavaScript (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`)
- Python (`.py`)

**Capabilities:**
- **Dependency Graph**: Visualize import/require relationships between modules
- **Color-Coded Categories**: Automatic classification of files into categories:
  - Core: Logic, extract, schema, enrich modules
  - Report: Report, transform, graph operations
  - Config: Validate, config, CLI, utilities
  - Tool: Tools, cache, special interfaces
  - Entry: Entry points, common utilities
- **VSCode Theme Integration**: Node backgrounds adapt to your VSCode theme (dark/light)
- **High-Contrast Visualization**: Color-coded edges and strokes for easy identification
- **Interactive Navigation**: Zoom, pan, and explore large dependency graphs
- **Folder Hierarchy**: Subgraphs organized by directory structure

**Usage:**
- Right-click on a folder in the Explorer → "Visualize Codebase Flow"
- Or use Command Palette: "Visualize Codebase Flow"

### Customization

- **9 Beautiful Themes**: Monokai, Catppuccin, GitHub, Solarized, One Dark Pro, Dracula, Material Theme, Nord, Tokyo Night
- **Auto-refresh**: Automatically update flowcharts on code changes
- **Performance Optimized**: Efficient parsing with Tree-sitter (WASM)

### AI-Powered Features (Function Flowcharts Only)

**Note:** AI features are only available for function-level flowcharts, not for codebase dependency visualization.

- **Smart Labels**: AI-generated human-friendly node labels for function flowcharts
- **Multiple Providers**: OpenAI, Gemini, Groq, Ollama (local), Anthropic
- **Intelligent Caching**: Efficient caching to minimize API calls
- **Customizable Style**: Concise, explanatory, or technical label styles
- **Multi-language Support**: Generate labels in your preferred language

When enabled, AI labels replace technical node labels (like variable names, condition expressions) with more readable descriptions, making flowcharts easier to understand at a glance.

### Developer Experience

- **Auto-refresh**: Automatically update flowcharts on code changes
- **Performance Optimized**: Efficient parsing with Tree-sitter (WASM)
- **Keyboard Shortcuts**: Quick access to all features

## How It Works

### Function-Level Flowchart Pipeline

1. **Parsing**: Uses Tree-sitter parsers (compiled to WASM) to parse source code into Abstract Syntax Trees (AST)
2. **Analysis**: Traverses the AST to identify:
   - Control flow structures (if/else, switch, loops)
   - Function boundaries
   - Exception handling
   - Async operations
   - Data operations (assignments, function calls)
3. **IR Generation**: Converts AST into an Intermediate Representation (IR) with nodes and edges
4. **Visualization**: Generates Mermaid diagram code from IR
5. **Rendering**: Renders interactive flowchart using Mermaid.js in webview

### Codebase Dependency Analysis Pipeline

1. **File Discovery**: Scans workspace for supported files (TypeScript/JavaScript, Python)
2. **Dependency Extraction**: Parses import/require statements to identify module dependencies
3. **Path Resolution**: Resolves relative and absolute import paths to actual file locations
4. **Graph Building**: Constructs dependency graph with nodes (files) and edges (dependencies)
5. **Classification**: Categorizes files based on path patterns and naming conventions
6. **Visualization**: Generates Mermaid flowchart with color-coded nodes and edges
7. **Rendering**: Displays interactive dependency graph with zoom/pan capabilities

### AI Label Generation (Function Flowcharts Only)

**Note:** This feature is only available for function-level flowcharts. Codebase dependency visualization uses file names and paths directly without AI enhancement.

1. **Extraction**: Extracts node labels from generated Mermaid code for function flowcharts
2. **Caching**: Checks cache for previously generated labels
3. **Translation**: Sends uncached labels to selected LLM provider
4. **Replacement**: Replaces technical labels with human-friendly descriptions
5. **Storage**: Caches results for future use

## Privacy & Security

### Data Handling

**Code Analysis:**
- All code parsing happens **locally** on your machine
- No code is sent to external servers for flowchart generation
- AST parsing uses local Tree-sitter WASM parsers
- Your source code never leaves your computer

**AI Features (Optional):**
- When AI labels are enabled, **only node labels** (not full code) are sent to LLM providers
- API keys are stored securely using VS Code's Secret Storage API
- Caching minimizes API calls and reduces data transmission
- You can use local models (Ollama) for complete privacy
- All AI features are **opt-in** and disabled by default

### What Data is Collected?

**None.** CodeVisualizer does not collect, store, or transmit:
- Your source code
- File contents
- Personal information
- Usage statistics
- Telemetry data

**Exception:** Only when AI labels are explicitly enabled, minimal label text is sent to your chosen LLM provider (OpenAI, Gemini, etc.) for translation. This is completely optional and can be disabled at any time.

### API Keys

- API keys are stored using VS Code's secure Secret Storage
- Keys are encrypted and stored locally
- Never transmitted except to the selected LLM provider when making API calls
- You can clear stored keys anytime via settings

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "CodeVisualizer"
4. Click Install

### From Source

```bash
git clone https://github.com/DucPhamNgoc08/CodeVisualizer.git
cd CodeVisualizer
npm install
npm run compile
```

Then press F5 in VS Code to run the extension in a new window.

## Usage

### Generating Function Flowcharts

1. **Open a file** in your editor
2. **Right-click** → "CodeVisualizer: Open flowchart in new window"
   - Or use Command Palette (Ctrl+Shift+P / Cmd+Shift+P)

### Visualizing Codebase Dependencies

1. **Right-click on a folder** in the Explorer panel or use Command Palette: "CodeVisualizer: Visualize Codebase Flow"
2. Select **"Visualize Codebase Flow"**
3. The dependency graph will open in a new panel showing:
   - All files in the selected folder and subfolders
   - Import/require relationships between modules
   - Color-coded file categories
   - Interactive zoom and pan controls

## Supported Languages

### Function-Level Flowcharts

| Language | Status |
|----------|--------|
| Python | Full Support |
| TypeScript/JavaScript | Full Support |
| Java | Full Support |
| C++ | Full Support |
| C | Full Support |
| Rust | Full Support |
| Go | Full Support |

### Codebase Dependency Visualization

| Language | Status | File Extensions |
|----------|--------|----------------|
| TypeScript/JavaScript | Full Support | `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs` |
| Python | Full Support | `.py` |

**Note:** Codebase dependency analysis currently supports TypeScript/JavaScript and Python. Support for additional languages (Java, C++, C, Rust, Go) is planned for future releases.

## Known Issues

- Export functionality is currently in development
- Large files (>10,000 lines) may take longer to parse
- Codebase visualization is limited to TypeScript/JavaScript and Python projects

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/DucPhamNgoc08/CodeVisualizer/issues)
- **Repository**: [GitHub](https://github.com/DucPhamNgoc08/CodeVisualizer)

---

**Made with dedication by Duc Pham Ngoc**
