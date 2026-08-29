import { expect } from "chai";
import { listCodingPlanProfiles } from "../src/modules/codingPlanProfiles";
import { endpointProviderOptions } from "../src/modules/views/ui/EndpointSettingsPanel";
import { LLMNoteMetadataService } from "../src/modules/llmNoteMetadata";

const originalAddon = (globalThis as any).addon;
let initialAddon: any;
let initialLocale: any;
let initialHasLocale = false;

function createLocaleFreeAddon(): any {
  if (!originalAddon) return { data: {} };
  const data = { ...(originalAddon.data || {}) };
  delete data.locale;
  return { ...originalAddon, data };
}

function hasLocaleProperty(data: any): boolean {
  return Boolean(data && Object.prototype.hasOwnProperty.call(data, "locale"));
}

function restoreLocaleProperty(
  data: any,
  hadLocaleProperty: boolean,
  locale: any,
): void {
  if (hadLocaleProperty) data.locale = locale;
  else delete data.locale;
}

describe("Coding Plan provider settings UI", function () {
  let previousAddon: any;
  let previousLocale: any;
  let previousHasLocale = false;

  before(function () {
    const baselineAddon = createLocaleFreeAddon();
    baselineAddon.data = baselineAddon.data || {};
    delete baselineAddon.data.locale;
    (globalThis as any).addon = baselineAddon;
    initialAddon = baselineAddon;
    initialLocale = baselineAddon.data.locale;
    initialHasLocale = hasLocaleProperty(baselineAddon.data);
  });

  after(function () {
    if (originalAddon) (globalThis as any).addon = originalAddon;
    else delete (globalThis as any).addon;
  });

  beforeEach(function () {
    previousAddon = (globalThis as any).addon;
    previousLocale = previousAddon?.data?.locale;
    previousHasLocale = hasLocaleProperty(previousAddon?.data);
    const globalAddon = (globalThis as any).addon || { data: {} };
    (globalThis as any).addon = globalAddon;
    globalAddon.data = globalAddon.data || {};
    globalAddon.data.locale = {
      current: {
        formatMessagesSync(requests: Array<{ id: string }>) {
          return requests.map(() => ({ value: undefined, attributes: [] }));
        },
      },
    };
  });

  afterEach(function () {
    if (previousAddon) {
      previousAddon.data = previousAddon.data || {};
      restoreLocaleProperty(
        previousAddon.data,
        previousHasLocale,
        previousLocale,
      );
      (globalThis as any).addon = previousAddon;
    } else {
      delete (globalThis as any).addon;
    }
  });

  it("exposes every catalog profile with its defaults and UI capability metadata", function () {
    const options = endpointProviderOptions() as Array<{
      value: string;
      label: string;
      codingPlanProfile?: string;
      defaultApiUrl?: string;
      defaultModel?: string;
      ui?: {
        showApiUrl: boolean;
        showApiKey: boolean;
        showClaudeBinaryPath: boolean;
        showClaudePermissionMode: boolean;
        showClaudeRestricted: boolean;
        showClaudeOutputFormat: boolean;
        supportsConnectionTest: boolean;
        pdfModes: string[];
        mcpEnabled: boolean;
      };
    }>;

    for (const profile of listCodingPlanProfiles()) {
      const option = options.find(
        (candidate) => candidate.value === profile.id,
      );
      expect(option, `missing ${profile.id} provider option`).to.not.equal(
        undefined,
      );
      expect(option).to.include({
        codingPlanProfile: profile.id,
        defaultApiUrl: profile.defaultApiUrl,
        defaultModel: profile.defaultModel,
      });
      expect(option?.label.trim()).to.not.equal("");
      expect(option?.ui).to.deep.equal({
        showApiUrl: profile.protocol === "openai-chat",
        showApiKey: profile.requiresApiKey,
        showClaudeBinaryPath: profile.id === "claude-code-cli",
        showClaudePermissionMode: profile.id === "claude-code-cli",
        showClaudeRestricted: profile.id === "claude-code-cli",
        showClaudeOutputFormat: profile.id === "claude-code-cli",
        supportsConnectionTest: true,
        pdfModes: ["text", "mineru"],
        mcpEnabled: false,
      });
    }
  });

  it("preserves Coding Plan vendor and profile in note metadata", function () {
    const metadata = LLMNoteMetadataService.fromResponse("summary", {
      text: "summary",
      providerId: "openai-compat",
      providerName: "Kimi Code",
      model: "kimi-for-coding",
      codingPlanVendor: "kimi-code",
      codingPlanProfile: "kimi-code",
    } as any);

    expect(metadata).to.include({
      codingPlanVendor: "kimi-code",
      codingPlanProfile: "kimi-code",
    });
  });

  it("captures the restored locale before applying the next temporary setup", function () {
    expect(previousAddon).to.equal(initialAddon);
    expect(previousLocale).to.equal(initialLocale);
    expect(previousHasLocale).to.equal(initialHasLocale);
    expect(hasLocaleProperty((globalThis as any).addon?.data)).to.equal(true);
    expect((globalThis as any).addon?.data?.locale).to.not.equal(
      previousLocale,
    );
  });

  it("deletes a temporary locale when the original data had no locale property", function () {
    const data = { locale: { current: {} } };
    restoreLocaleProperty(data, false, undefined);
    expect(hasLocaleProperty(data)).to.equal(false);
  });
});
