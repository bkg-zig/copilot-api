import { readFile } from "node:fs/promises";

const providerID = "local";
const responsesPackage = "@opencode/ai/providers/openai/responses";

// Single-file plugin for OpenCode's v2 branch; no imports or dependencies.
export default {
  id: "local.provider",
  async setup(ctx) {
    const options = ctx.options ?? {};
    const baseURL = (
      options.baseURL ??
      process.env.COPILOT_API_URL ??
      "https://copi.eysho.info/v1"
    ).replace(/\/+$/u, "");
    const apiKeyFile =
      options.apiKeyFile ??
      process.env.COPILOT_API_KEY_FILE ??
      "/srv/bkg/services/copilot-api/.secrets/bkg-ov-client.key";
    const apiKey =
      options.apiKey ??
      process.env.GITHUB_COPILOT_API_KEY ??
      (await readFile(apiKeyFile, "utf8")).trim();
    if (!apiKey) throw new Error("Copilot API gateway key file is empty");
    const refreshIntervalMs = options.refreshIntervalMs ?? 10_000;
    const discoveryTimeoutMs = options.discoveryTimeoutMs ?? 30_000;
    const initialDiscoveryWaitMs = options.initialDiscoveryWaitMs ?? 750;
    const loadModels = async () => {
      const response = await fetch(`${baseURL}/models?wait=0`, {
        headers: {
          "user-agent": "opencode/copilot-api-provider",
          "x-api-key": apiKey,
        },
        signal: AbortSignal.timeout(discoveryTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Model discovery failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      if (
        !Array.isArray(body?.data) ||
        !body.data.every(
          (model) =>
            typeof model?.id === "string" &&
            typeof model?.modelID === "string" &&
            model?.capabilities &&
            Array.isArray(model?.cost),
        )
      ) {
        throw new Error("Invalid OpenCode v2 model catalog");
      }
      return body.data.map((model) => ({
        ...model,
        providerID,
        package: model.package ?? responsesPackage,
      }));
    };
    const reportError = (error) =>
      console.warn("copilot-api model discovery:", error?.message ?? error);
    let models = [];
    let stopped = false;
    let refreshing = true;
    let initialLoadFinished = false;
    let initialLoadWasReady = false;
    let providerRegistered = false;
    const initialLoad = loadModels()
      .then((next) => {
        models = next;
      })
      .catch(reportError)
      .finally(() => {
        initialLoadFinished = true;
        refreshing = false;
        if (providerRegistered && !initialLoadWasReady && !stopped) {
          void ctx.provider.reload().catch(reportError);
        }
      });
    await Promise.race([
      initialLoad,
      new Promise((resolve) => setTimeout(resolve, initialDiscoveryWaitMs)),
    ]);
    initialLoadWasReady = initialLoadFinished;
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: providerID,
          name: "My Local",
          activation: "enabled",
          package: responsesPackage,
          settings: { baseURL, apiKey, compaction: { type: "native" } },
        },
        models,
      });
    });
    providerRegistered = true;
    if (initialLoadFinished && !initialLoadWasReady && !stopped) {
      void ctx.provider.reload().catch(reportError);
    }
    const refresh = async () => {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        const next = await loadModels();
        if (stopped) return;
        models = next;
        await ctx.provider.reload();
      } finally {
        refreshing = false;
      }
    };
    const timer =
      refreshIntervalMs > 0
        ? setInterval(
            () => void refresh().catch(reportError),
            refreshIntervalMs,
          )
        : undefined;
    return () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    };
  },
};
