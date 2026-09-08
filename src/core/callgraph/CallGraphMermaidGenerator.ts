import { UsageGraph, UsageGraphNode } from "./CallGraphAnalyzer";

/** Location metadata used by the webview to navigate to a function on click. */
export interface CallGraphNodeLocation {
  file: string;
  start: number;
  end: number;
}

export interface CallGraphRenderResult {
  mermaid: string;
  /** node id -> source location, consumed by the webview for navigation. */
  locations: Record<string, CallGraphNodeLocation>;
}

/**
 * Renders a usage (reverse call) graph as Mermaid. Edges point from caller to
 * callee, so the target function sits at the bottom and its (transitive)
 * callers flow in from the top.
 */
export class CallGraphMermaidGenerator {
  public generate(graph: UsageGraph): CallGraphRenderResult {
    const lines: string[] = ["flowchart TD"];
    const locations: Record<string, CallGraphNodeLocation> = {};

    for (const node of graph.nodes) {
      lines.push(`    ${node.id}["${this.renderLabel(node)}"]`);
      locations[node.id] = {
        file: node.file,
        start: node.startIndex,
        end: node.endIndex,
      };
    }

    for (const edge of graph.edges) {
      lines.push(`    ${edge.from} --> ${edge.to}`);
    }

    // Highlight the target node.
    const target = graph.nodes.find((n) => n.isTarget);
    lines.push(
      "    classDef targetStyle fill:#ffd54f,stroke:#ff6f00,stroke-width:3px,color:#000"
    );
    lines.push(
      "    classDef callerStyle fill:#e3f2fd,stroke:#1976d2,stroke-width:1.5px,color:#000"
    );
    if (target) {
      lines.push(`    class ${target.id} targetStyle`);
    }
    const callerIds = graph.nodes
      .filter((n) => !n.isTarget)
      .map((n) => n.id);
    if (callerIds.length > 0) {
      lines.push(`    class ${callerIds.join(",")} callerStyle`);
    }

    return { mermaid: lines.join("\n"), locations };
  }

  private renderLabel(node: UsageGraphNode): string {
    const second = node.relativePath
      ? `${this.escape(node.relativePath.replace(/\\/g, "/"))}:${node.line}`
      : "definition not found";
    return `${this.escape(node.name)} - ${second}`;
  }

  private escape(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, "#quot;")
      .replace(/</g, "#60;")
      .replace(/>/g, "#62;")
      .replace(/`/g, "#96;")
      .replace(/\r?\n/g, " ");
  }
}
