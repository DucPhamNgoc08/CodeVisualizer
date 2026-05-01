<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]
[![VS Code][vscode-shield]][vscode-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/DucPhamNgoc08/CodeVisualizer">
    <img src="media/codevisualizerlogo.png" alt="Logo" width="200" height="200">
  </a>

  <h3 align="center">CodeVisualizer</h3>

  <p align="center">
    Real-time interactive flowcharts and dependency visualization for your code
    <br />
    <a href="https://marketplace.visualstudio.com/items?itemName=DucPhamNgoc.codevisualizer">Download Extension</a>
    ·
    <a href="https://github.com/DucPhamNgoc08/CodeVisualizer/issues/new?labels=bug&template=bug-report---.md">Report Bug</a>
    ·
    <a href="https://github.com/DucPhamNgoc08/CodeVisualizer/issues/new?labels=enhancement&template=feature-request---.md">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
        <li><a href="#key-features">Key Features</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#supported-languages">Supported Languages</a></li>
    <li><a href="#how-it-works">How It Works</a></li>
    <li><a href="#privacy--security">Privacy & Security</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

[![CodeVisualizer Demo][product-video]](https://github.com/user-attachments/assets/e74b33ba-a22d-48a4-8f7c-e7edc9077e62)

CodeVisualizer is a powerful VS Code extension that transforms the way you understand and navigate code. Whether you're diving into a new codebase, debugging complex logic, or documenting your architecture, CodeVisualizer provides instant visual insights through two powerful visualization modes.

**Why CodeVisualizer?**

* Understand complex codebases instantly with interactive dependency graphs showing how your modules connect
* Debug and comprehend function logic through beautiful flowcharts that reveal control flow, loops, and decision points
* Save hours of manual diagramming - generate production-ready visualizations in seconds
* Support for 8+ programming languages with intelligent semantic analysis
* Privacy-first design - all code analysis happens locally on your machine

CodeVisualizer bridges the gap between code and comprehension, making it easier for developers to onboard, debug, and maintain software projects of any size.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

This extension leverages cutting-edge technologies to deliver fast, accurate code analysis and beautiful visualizations:

* [![TypeScript][TypeScript]][TypeScript-url]
* [![Node.js][Node.js]][Node-url]
* [![VS Code API][VSCode]][VSCode-url]
* [![Tree-sitter][Tree-sitter]][Tree-sitter-url]
* [![Mermaid][Mermaid]][Mermaid-url]
* [![WebAssembly][WASM]][WASM-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Key Features

> **Note on Language Support:**  
> - **Function-Level Flowcharts**: Supports Python, TypeScript/JavaScript, Java, C++, C, Rust, Go, and PHP  
> - **Codebase Dependency Visualization**: Currently supports TypeScript/JavaScript, Python, and PHP (more languages coming soon)  
> - **AI-Powered Features**: Available only for Function-Level Flowcharts

#### Function-Level Flowchart Generation

Transform individual functions into interactive, visual flowcharts to understand control flow, decision points, and execution paths.

**Capabilities:**
- **Multi-language Support**: Parse and visualize functions across Python, TypeScript/JavaScript, Java, C++, C, Rust, Go, and PHP
- **Interactive Visualization**: Click nodes to navigate to code, zoom and pan for detailed exploration
- **Multiple Views**: Sidebar view for quick reference and detachable panel windows for deep analysis
- **Semantic Analysis**: Intelligent understanding of control flow, loops, exceptions, and async operations
- **9 Beautiful Themes**: Choose from Monokai, Catppuccin, GitHub, Solarized, One Dark Pro, Dracula, Material Theme, Nord, or Tokyo Night
- **Auto-refresh**: Automatically update flowcharts as you edit code

#### Codebase Dependency Visualization

Analyze and visualize your entire codebase structure, revealing module dependencies, file relationships, and project architecture at a glance.

**Capabilities:**
- **Dependency Graph**: Complete visualization of import/require relationships between modules
- **Color-Coded Categories**: Automatic file classification into Core, Report, Config, Tool, and Entry categories
- **VSCode Theme Integration**: Seamless dark/light theme support matching your editor
- **High-Contrast Visualization**: Color-coded edges and strokes for instant comprehension
- **Interactive Navigation**: Zoom, pan, and explore even the largest dependency graphs smoothly
- **Folder Hierarchy**: Smart subgraphs organized by your directory structure

#### AI-Powered Features (Function Flowcharts)

**Note:** AI features enhance function-level flowcharts only, making complex logic instantly readable.

- **Smart Labels**: AI-generated human-friendly descriptions replace cryptic variable names and expressions
- **Multiple Providers**: Works with OpenAI, Gemini, Groq, Ollama (local), and Anthropic
- **Intelligent Caching**: Minimizes API calls and costs through efficient label caching
- **Customizable Styles**: Choose between concise, explanatory, or technical label formats
- **Multi-language Support**: Generate labels in your preferred language for global teams

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

Get CodeVisualizer up and running in your VS Code environment in just a few clicks.

### Prerequisites

* Visual Studio Code version 1.105.0 or higher
* Active workspace with supported programming languages (Python, TypeScript/JavaScript, Java, C++, C, Rust, or Go)

### Installation

1. **Install from VS Code Marketplace**
   - Open VS Code
   - Press `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (Mac) to open Extensions
   - Search for "CodeVisualizer"
   - Click **Install**

2. **Install from VSIX file** (if applicable)
   ```sh
   code --install-extension codevisualizer-1.0.2.vsix
   ```

3. **Configure AI Features (Optional)**
   - Open Settings: `Ctrl+,` (Windows/Linux) or `Cmd+,` (Mac)
   - Search for "CodeVisualizer"
   - Enable AI labels and add your API key for supported providers
   - Or use Ollama for completely local AI processing

4. **Start Visualizing**
   - Right-click any function → "CodeVisualizer: Open flowchart in new window"
   - Right-click any folder → "Visualize Codebase Flow"

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

### Generating Function Flowcharts

1. Open any supported source file in VS Code
2. Right-click in the editor
3. Select **"CodeVisualizer: Open flowchart in new window"**
   - Alternatively, use Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "CodeVisualizer"
4. Explore the interactive flowchart:
   - Click nodes to jump to corresponding code
   - Zoom in/out with mouse wheel
   - Pan by clicking and dragging
   - Switch themes from the settings icon

### Visualizing Codebase Dependencies

1. In the Explorer sidebar, right-click on any folder containing your source code
   - Alternatively, use Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "Visualize Codebase Flow"
2. Select **"Visualize Codebase Flow"**
3. Explore the dependency graph:
   - View color-coded file categories
   - Trace import chains between modules
   - Identify circular dependencies
   - Understand your project architecture at a glance

### AI-Enhanced Labels (Function Flowcharts)

1. Enable AI labels in Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "CodeVisualizer: Enable AI Labels"
2. Configure your preferred LLM provider and API key
3. Generate a flowchart - AI labels will automatically replace technical labels

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- SUPPORTED LANGUAGES -->
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
| PHP | Full Support |

### Codebase Dependency Visualization

| Language | Status | File Extensions | 
|----------|--------|----------------|
| TypeScript/JavaScript | Full Support | `.js`, `.ts`, `.mjs`, `.cjs` | 
| Python | Full Support | `.py` | 
| PHP | Basic Support | `.php` |

**Planned Support:** Java, C++, C, Rust, Go dependency analysis coming in future releases.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- HOW IT WORKS -->
## How It Works

### Function-Level Flowchart Pipeline

1. **Parsing**: Tree-sitter parsers (compiled to WASM) convert source code into Abstract Syntax Trees (AST)
2. **Analysis**: AST traversal identifies control structures, function boundaries, exception handling, async operations, and data flow
3. **IR Generation**: AST is transformed into an Intermediate Representation (IR) with nodes representing code blocks and edges showing flow
4. **Visualization**: IR is converted to Mermaid diagram syntax
5. **Rendering**: Mermaid.js renders an interactive flowchart in a VS Code webview panel

### Codebase Dependency Analysis Pipeline

1. **File Discovery**: Scans workspace recursively for supported file types
2. **Dependency Extraction**: Parses import/require statements using language-specific parsers
3. **Path Resolution**: Resolves relative and absolute import paths to actual file locations
4. **Graph Building**: Constructs a directed graph with files as nodes and dependencies as edges
5. **Classification**: Categorizes files based on naming patterns and directory structure
6. **Visualization**: Generates Mermaid flowchart with color-coded nodes and edges
7. **Rendering**: Displays an interactive graph with zoom, pan, and navigation features

### AI Label Generation (Function Flowcharts)

1. **Extraction**: Extracts node labels from generated Mermaid code
2. **Caching**: Checks local cache for previously generated labels
3. **Translation**: Sends uncached labels to selected LLM provider with optimized prompts
4. **Replacement**: Replaces technical labels with human-friendly descriptions
5. **Storage**: Caches results locally to minimize future API calls

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- PRIVACY & SECURITY -->
## Privacy & Security

### Data Handling

**Code Analysis:**
- All code parsing happens **100% locally** on your machine
- No code is ever sent to external servers for flowchart generation
- AST parsing uses local Tree-sitter WASM parsers with zero network requests
- Your source code never leaves your computer

**AI Features (Optional & Opt-in):**
- When AI labels are enabled, **only node labels** (short text snippets, not full code) are sent to LLM providers
- API keys are stored securely using VS Code's built-in Secret Storage API with encryption
- Smart caching minimizes API calls and reduces data transmission
- Use Ollama for complete privacy with local model processing
- All AI features are **disabled by default** and require explicit user activation

### What Data is Collected?

**None.** CodeVisualizer does not collect, store, or transmit your data.

**Exception:** When AI labels are explicitly enabled by you, minimal label text (e.g., "if x > 0", "return result") is sent to your chosen LLM provider for translation. This is completely optional and can be disabled anytime.

### API Key Security

- Stored using VS Code's secure Secret Storage (encrypted at rest)
- Never transmitted except to your selected LLM provider during API calls
- Can be cleared instantly via settings
- Not included in any logs or diagnostic reports

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Development Setup

```sh
# Clone the repository
git clone https://github.com/DucPhamNgoc08/CodeVisualizer.git

# Install dependencies
npm install

# Open in VS Code
code .

# Press F5 to launch Extension Development Host
```

### Top contributors:

<a href="https://github.com/DucPhamNgoc08/CodeVisualizer/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=DucPhamNgoc08/CodeVisualizer" alt="contrib.rocks image" />
</a>

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Duc Pham Ngoc - Ducphamngoc39@gmail.com

Project Link: [https://github.com/DucPhamNgoc08/CodeVisualizer](https://github.com/DucPhamNgoc08/CodeVisualizer)

Support:
- **Issues**: [GitHub Issues](https://github.com/DucPhamNgoc08/CodeVisualizer/issues)
- **Discussions**: [GitHub Discussions](https://github.com/DucPhamNgoc08/CodeVisualizer/discussions)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/DucPhamNgoc08/CodeVisualizer.svg?style=for-the-badge
[contributors-url]: https://github.com/DucPhamNgoc08/CodeVisualizer/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/DucPhamNgoc08/CodeVisualizer.svg?style=for-the-badge
[forks-url]: https://github.com/DucPhamNgoc08/CodeVisualizer/network/members
[stars-shield]: https://img.shields.io/github/stars/DucPhamNgoc08/CodeVisualizer.svg?style=for-the-badge
[stars-url]: https://github.com/DucPhamNgoc08/CodeVisualizer/stargazers
[issues-shield]: https://img.shields.io/github/issues/DucPhamNgoc08/CodeVisualizer.svg?style=for-the-badge
[issues-url]: https://github.com/DucPhamNgoc08/CodeVisualizer/issues
[license-shield]: https://img.shields.io/github/license/DucPhamNgoc08/CodeVisualizer.svg?style=for-the-badge
[license-url]: https://github.com/DucPhamNgoc08/CodeVisualizer/blob/master/LICENSE.txt
[vscode-shield]: https://img.shields.io/badge/VS%20Code-1.105.0+-007ACC?style=for-the-badge&logo=visual-studio-code
[vscode-url]: https://code.visualstudio.com/
[product-screenshot]: images/screenshot.png
[TypeScript]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Node.js]: https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white
[Node-url]: https://nodejs.org/
[VSCode]: https://img.shields.io/badge/VS%20Code%20API-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white
[VSCode-url]: https://code.visualstudio.com/api
[Tree-sitter]: https://img.shields.io/badge/Tree--sitter-3DDC84?style=for-the-badge&logo=tree&logoColor=white
[Tree-sitter-url]: https://tree-sitter.github.io/tree-sitter/
[Mermaid]: https://img.shields.io/badge/Mermaid-FF3670?style=for-the-badge&logo=mermaid&logoColor=white
[Mermaid-url]: https://mermaid.js.org/
[WASM]: https://img.shields.io/badge/WebAssembly-654FF0?style=for-the-badge&logo=webassembly&logoColor=white
[WASM-url]: https://webassembly.org/
