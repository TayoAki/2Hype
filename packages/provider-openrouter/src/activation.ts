import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigActionLimits,
  runtimeConfigCredentialRef,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-local/extension";

import { createOpenRouterProvider, diagnoseOpenRouterProvider } from "./provider.js";
import type { CreateOpenRouterProviderOptions, GptImageQuality, PersonReferencePolicy } from "./provider.js";

const QUALITIES: readonly GptImageQuality[] = ["auto", "low", "medium", "high"];
const PERSON_POLICIES: readonly PersonReferencePolicy[] = ["submit", "refuse"];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], subject: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${subject} must be one of ${allowed.join(", ")}`);
  return value as T;
}

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-openrouter",
  activate(context) {
    if (context.pool === undefined) throw new Error("OpenRouter Provider Pool is required");
    const config = runtimeConfigObject(context.config, "OpenRouter");
    runtimeConfigExact(config, [
      "baseUrl", "apiKey", "defaultConcurrency", "actionLimits", "pollIntervalMs", "requestTimeoutMs",
      "imageTimeoutMs", "downloadTimeoutMs", "gptImageQuality", "personReferences", "maxInlineMegabytes",
      "stagingDirectory", "stagingBaseUrl",
    ], "OpenRouter");
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "OpenRouter apiKey");
    if (apiKey === undefined) throw new Error("OpenRouter apiKey CredentialRef is required");
    const baseUrl = runtimeConfigString(config.baseUrl, "OpenRouter baseUrl");
    const actionLimits = runtimeConfigActionLimits(config.actionLimits);
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "OpenRouter defaultConcurrency");
    const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "OpenRouter pollIntervalMs");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "OpenRouter requestTimeoutMs");
    const imageTimeoutMs = runtimeConfigPositiveInteger(config.imageTimeoutMs, "OpenRouter imageTimeoutMs");
    const downloadTimeoutMs = runtimeConfigPositiveInteger(config.downloadTimeoutMs, "OpenRouter downloadTimeoutMs");
    const maxInlineMegabytes = runtimeConfigPositiveInteger(config.maxInlineMegabytes, "OpenRouter maxInlineMegabytes");
    const gptImageQuality = oneOf(runtimeConfigString(config.gptImageQuality, "OpenRouter gptImageQuality"),
      QUALITIES, "OpenRouter gptImageQuality");
    const personReferences = oneOf(runtimeConfigString(config.personReferences, "OpenRouter personReferences"),
      PERSON_POLICIES, "OpenRouter personReferences");
    const stagingDirectory = runtimeConfigString(config.stagingDirectory, "OpenRouter stagingDirectory");
    const stagingBaseUrl = runtimeConfigString(config.stagingBaseUrl, "OpenRouter stagingBaseUrl");
    if ((stagingDirectory === undefined) !== (stagingBaseUrl === undefined)) {
      throw new Error("OpenRouter stagingDirectory and stagingBaseUrl must be set together");
    }
    const options: CreateOpenRouterProviderOptions = {
      instance: context.instance,
      pool: context.pool,
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(actionLimits === undefined ? {} : { actionLimits }),
      ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(imageTimeoutMs === undefined ? {} : { imageTimeoutMs }),
      ...(downloadTimeoutMs === undefined ? {} : { downloadTimeoutMs }),
      ...(maxInlineMegabytes === undefined ? {} : { maxInlineBytes: maxInlineMegabytes * 1024 * 1024 }),
      ...(gptImageQuality === undefined ? {} : { gptImageQuality }),
      ...(personReferences === undefined ? {} : { personReferences }),
      ...(stagingDirectory === undefined || stagingBaseUrl === undefined ? {}
        : { referenceStaging: { directory: stagingDirectory, baseUrl: stagingBaseUrl } }),
    };
    return {
      endpoint: createOpenRouterProvider(options),
      diagnose: async (doctor) => await diagnoseOpenRouterProvider(options, doctor),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [adapter],
};

export default hypitPackage;
