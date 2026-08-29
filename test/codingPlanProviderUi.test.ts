import { expect } from "chai";
import { listCodingPlanProfiles } from "../src/modules/codingPlanProfiles";
import { endpointProviderOptions } from "../src/modules/views/ui/EndpointSettingsPanel";
import { LLMNoteMetadataService } from "../src/modules/llmNoteMetadata";

describe("Coding Plan provider settings UI", function () {
  let previousAddon: any;

  beforeEach(function () {
    previousAddon = (globalThis as any).addon;
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
    if (previousAddon) (globalThis as any).addon = previousAddon;
    else delete (globalThis as any).addon;
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
});
