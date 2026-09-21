import * as vscode from "vscode";
import {
  LLMService,
  Provider,
  getGroqModels,
  getLiteLLMModels,
  getOllamaModels,
  LITELLM_DEFAULT_BASE_URL,
  extractNodeLabels,
  replaceNodeLabels,
  ExtractedLabels,
} from "./LLMService";
import { logInfo, logWarn } from "./LLMLogger";
import { CacheManager } from "./CacheManager";

export class LLMManager {
  private static mermaidCache = new CacheManager<string>("codevisualizer.llm.cache");
  private static labelCache = new CacheManager<string>("codevisualizer.llm.labelCache");

  public static async isEnabled(
    context: vscode.ExtensionContext,
  ): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration("codevisualizer.llm");
    const enabled = cfg.get<boolean>("enabled", false);
    if (!enabled) {
      return false;
    }
    const provider = cfg.get<string>("provider", "openai") as Provider;
    if (provider === "ollama" || provider === "litellm") {
      // Ollama runs locally; a LiteLLM proxy's virtual key is optional.
      return true;
    }
    const key = await context.secrets.get(LLMManager.secretKeyName(provider));
    return Boolean(key);
  }

  public static async enableLLM(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    const providerPick = await vscode.window.showQuickPick(
      [
        { label: "OpenAI", value: "openai" },
        { label: "Atlas Cloud", value: "atlascloud" },
        { label: "LiteLLM (proxy)", value: "litellm" },
        { label: "Gemini", value: "gemini" },
        { label: "Groq", value: "groq" },
        { label: "Ollama (local)", value: "ollama" },
      ],
      {
        title: "Choose LLM Provider",
        placeHolder: "Select the provider for rewriting node labels",
      },
    );
    if (!providerPick) return;
    const provider = providerPick.value as Provider;

    // For Ollama, we don't need an API key; optionally collect base URL
    let baseUrl: string | undefined;
    if (provider === "ollama") {
      baseUrl = await vscode.window.showInputBox({
        title: `Ollama Base URL`,
        placeHolder: "http://localhost:11434",
        value: "http://localhost:11434",
        ignoreFocusOut: true,
        prompt: "Enter the Ollama server URL if different from default",
      });
      if (baseUrl)
        await context.secrets.store(
          LLMManager.secretBaseUrlName("ollama"),
          baseUrl,
        );
    } else if (provider === "litellm") {
      baseUrl = await vscode.window.showInputBox({
        title: "LiteLLM Proxy URL",
        placeHolder: LITELLM_DEFAULT_BASE_URL,
        value: LITELLM_DEFAULT_BASE_URL,
        ignoreFocusOut: true,
        prompt: "URL of your LiteLLM proxy (with or without /v1)",
      });
      if (!baseUrl) {
        return;
      }
      await context.secrets.store(
        LLMManager.secretBaseUrlName("litellm"),
        baseUrl,
      );
      const virtualKey = await vscode.window.showInputBox({
        title: "LiteLLM Virtual Key (optional)",
        placeHolder: "sk-... (leave empty if the proxy has no master key)",
        ignoreFocusOut: true,
        password: true,
      });
      if (virtualKey === undefined) {
        return;
      }
      if (virtualKey) {
        await context.secrets.store(
          LLMManager.secretKeyName("litellm"),
          virtualKey,
        );
      } else {
        await context.secrets.delete(LLMManager.secretKeyName("litellm"));
      }
    } else {
      const apiKey = await vscode.window.showInputBox({
        title: `${providerPick.label} API Key`,
        placeHolder: "Enter your API key",
        ignoreFocusOut: true,
        password: true,
        validateInput: (val) => (!val ? "API key is required" : undefined),
      });
      if (!apiKey) return;
      await context.secrets.store(LLMManager.secretKeyName(provider), apiKey);
    }
    await vscode.workspace
      .getConfiguration("codevisualizer.llm")
      .update("provider", provider, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("codevisualizer.llm")
      .update("enabled", true, vscode.ConfigurationTarget.Global);

    // Select model as part of onboarding
    let suggestions: string[] = LLMService.getDefaultModels(provider);
    if (provider === "groq") {
      logInfo("Fetching Groq models during onboarding");
      const apiKey = await context.secrets.get(
        LLMManager.secretKeyName("groq"),
      );
      const remote = apiKey ? await getGroqModels(apiKey) : [];
      if (remote.length > 0) suggestions = remote;
    }
    if (provider === "ollama") {
      const base =
        (await context.secrets.get(LLMManager.secretBaseUrlName("ollama"))) ||
        undefined;
      const remote = await getOllamaModels(base);
      if (remote.length > 0) suggestions = remote;
    }
    if (provider === "litellm") {
      suggestions = await LLMManager.fetchLiteLLMModels(context);
    }
    const modelPick = await vscode.window.showQuickPick(
      [
        ...suggestions.map((m) => ({ label: m, value: m })),
        { label: "Custom...", value: "__custom__" },
      ],
      {
        title: "Choose LLM Model",
        placeHolder: suggestions[0] || "Enter a model",
      },
    );
    if (!modelPick) return;
    let model = modelPick.value;
    if (model === "__custom__") {
      const input = await vscode.window.showInputBox({
        title: "Custom model",
        value: suggestions[0] || "",
        ignoreFocusOut: true,
      });
      if (!input) return;
      model = input;
    }
    await vscode.workspace
      .getConfiguration("codevisualizer.llm")
      .update("model", model, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      `CodeVisualizer LLM enabled with ${providerPick.label} (${model}).`,
    );
  }

  public static async changeModel(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("codevisualizer.llm");
    const provider = cfg.get<string>("provider", "openai") as Provider;
    let suggestions = LLMService.getDefaultModels(provider);
    if (provider === "groq") {
      const apiKey = await context.secrets.get(
        LLMManager.secretKeyName("groq"),
      );
      if (apiKey) {
        const remote = await getGroqModels(apiKey);
        if (remote.length > 0) suggestions = remote;
      }
    }
    if (provider === "ollama") {
      const base =
        (await context.secrets.get(LLMManager.secretBaseUrlName("ollama"))) ||
        undefined;
      const remote = await getOllamaModels(base);
      if (remote.length > 0) suggestions = remote;
    }
    if (provider === "litellm") {
      suggestions = await LLMManager.fetchLiteLLMModels(context);
    }
    const current = cfg.get<string>("model", suggestions[0] || "");

    const pick = await vscode.window.showQuickPick(
      [
        ...suggestions.map((m) => ({ label: m, value: m })),
        { label: "Custom...", value: "__custom__" },
      ],
      { title: "Choose LLM Model", placeHolder: current },
    );
    if (!pick) return;
    let model = pick.value;
    if (model === "__custom__") {
      const input = await vscode.window.showInputBox({
        title: "Custom model",
        value: current,
        ignoreFocusOut: true,
      });
      if (!input) return;
      model = input;
    }
    await cfg.update("model", model, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      `CodeVisualizer LLM model set to ${model}.`,
    );
  }

  public static async resetCache(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    await this.mermaidCache.clear(context);
    await this.labelCache.clear(context);
    void vscode.window.showInformationMessage("CodeVisualizer LLM cache cleared.");
  }

  public static async getAvailability(
    context: vscode.ExtensionContext,
  ): Promise<{ enabled: boolean; provider: Provider; model: string }> {
    const cfg = vscode.workspace.getConfiguration("codevisualizer.llm");
    const provider = cfg.get<string>("provider", "openai") as Provider;
    let model = cfg.get<string>(
      "model",
      LLMService.getDefaultModels(provider)[0] || "",
    );
    if (!model) {
      const fallback = LLMService.getDefaultModels(provider)[0];
      if (fallback) {
        model = fallback;
      }
    }
    const enabled = await this.isEnabled(context);
    return { enabled, provider, model };
  }

  public static async translateIfNeeded(
    context: vscode.ExtensionContext,
    mermaidSource: string,
  ): Promise<string | null> {
    const { enabled, provider, model } = await this.getAvailability(context);
    const effectiveModel =
      model || LLMService.getDefaultModels(provider)[0] || "";
    logInfo(
      `translateIfNeeded: enabled=${enabled} provider=${provider} model=${effectiveModel}`,
    );
    if (!enabled) return null;
    const style = vscode.workspace
      .getConfiguration("codevisualizer.llm")
      .get<string>("style", "concise");
    const language = vscode.workspace
      .getConfiguration("codevisualizer.llm")
      .get<string>("language", "");
    const key =
      provider === "ollama"
        ? undefined
        : await context.secrets.get(this.secretKeyName(provider));
    let baseUrl: string | undefined = undefined;
    if (provider === "ollama" || provider === "litellm") {
      baseUrl =
        (await context.secrets.get(this.secretBaseUrlName(provider))) ||
        undefined;
    }
    if (provider !== "ollama" && provider !== "litellm" && !key) {
      logWarn(`No API key found for provider ${provider}`);
      return null;
    }

    const cacheKey = await LLMService.computeCacheKey(
      mermaidSource,
      provider,
      effectiveModel,
      style,
      language,
    );
    logInfo(`Cache key ${cacheKey.substring(0, 8)}...`);

    return this.mermaidCache.wrap(cacheKey, context, async () => {
      logInfo(`LLM call dispatch`);
      // Attempt incremental per-label caching flow for label-only providers
      if (provider !== "groq") {
        const extraction: ExtractedLabels = extractNodeLabels(mermaidSource);
        if (extraction && extraction.labels.length > 0) {
          // Determine which labels are already cached
          const labelKeys = await Promise.all(
            extraction.labels.map((label) =>
              LLMService.computeLabelCacheKey(
                label,
                provider,
                effectiveModel,
                style,
                language,
              ),
            ),
          );
          const missingIndices: number[] = [];
          const translatedLabels: string[] = new Array(
            extraction.labels.length,
          );
          for (let i = 0; i < labelKeys.length; i++) {
            const k = labelKeys[i];
            const cachedLabel = await this.labelCache.get(k, context);
            if (cachedLabel) {
              translatedLabels[i] = cachedLabel;
            } else {
              missingIndices.push(i);
            }
          }
          if (missingIndices.length === 0) {
            // Everything cached: rebuild without calling provider
            return replaceNodeLabels(
              mermaidSource,
              extraction,
              translatedLabels,
            );
          } else if (missingIndices.length > 0) {
            const missingLabels = missingIndices.map(
              (i) => extraction.labels[i],
            );
            const subset = await LLMServiceInstance.translateLabelSubset(
              {
                provider,
                model: effectiveModel,
                apiKey: key || "",
                style,
                language,
                baseUrl,
              },
              missingLabels,
            );
            if (subset && subset.length === missingLabels.length) {
              // Merge subset back
              for (let j = 0; j < missingIndices.length; j++) {
                const idx = missingIndices[j];
                translatedLabels[idx] = subset[j];
                const lk = labelKeys[idx];
                await this.labelCache.set(lk, subset[j], context);
              }
              // Rebuild mermaid
              return replaceNodeLabels(
                mermaidSource,
                extraction,
                translatedLabels,
              );
            }
            // If subset failed, fall through to full translation
          }
        }
      }

      const translated = await LLMServiceInstance.translateLabels({
        mermaidSource,
        provider,
        model: effectiveModel,
        apiKey: key || "",
        style,
        language,
        baseUrl,
      });
      logInfo(`LLM call resolved: ${translated ? "ok" : "null"}`);
      return translated || mermaidSource;
    });
  }

  private static async fetchLiteLLMModels(
    context: vscode.ExtensionContext,
  ): Promise<string[]> {
    const base =
      (await context.secrets.get(LLMManager.secretBaseUrlName("litellm"))) ||
      undefined;
    const key =
      (await context.secrets.get(LLMManager.secretKeyName("litellm"))) ||
      undefined;
    logInfo("Fetching LiteLLM proxy models");
    const remote = await getLiteLLMModels(base, key);
    if (remote.length === 0) {
      logWarn("LiteLLM proxy returned no models; enter a model name manually");
    }
    return remote;
  }

  private static secretKeyName(provider: Provider): string {
    return `codevisualizer.llm.${provider}.apiKey`;
  }

  private static secretBaseUrlName(provider: Provider): string {
    return `codevisualizer.llm.${provider}.baseUrl`;
  }
}

// Lazily create a single service instance
const LLMServiceInstance = new LLMService();
