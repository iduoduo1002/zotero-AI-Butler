import { expect } from "chai";
import { LLMService } from "../src/modules/llmService";
import {
  LLMEndpointManager,
  type LLMEndpoint,
} from "../src/modules/llmEndpointManager";
import { ProviderRegistry } from "../src/modules/llmproviders/ProviderRegistry";

const PROFILE_DEFAULTS = {
  "kimi-code": {
    apiUrl: "https://api.kimi.com/coding/v1/chat/completions",
    model: "kimi-for-coding",
  },
  "zhipu-glm-coding": {
    apiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    model: "glm-5.3",
  },
} as const;

type HttpCodingPlanVendor = keyof typeof PROFILE_DEFAULTS;
const HTTP_CODING_PLAN_VENDORS: HttpCodingPlanVendor[] = [
  "kimi-code",
  "zhipu-glm-coding",
];

function makeProfileEndpoint(vendor: HttpCodingPlanVendor): LLMEndpoint {
  const endpoint = LLMEndpointManager.createEndpoint("openai-compat");
  return {
    ...endpoint,
    id: `${vendor}-service-boundary`,
    apiUrl: PROFILE_DEFAULTS[vendor].apiUrl,
    apiKey: `${vendor}-key`,
    model: PROFILE_DEFAULTS[vendor].model,
    codingPlanVendor: vendor,
    codingPlanProfile: vendor,
    enabled: true,
  };
}

async function expectProfileInputRejected(
  vendor: HttpCodingPlanVendor,
  request: () => Promise<unknown>,
): Promise<void> {
  LLMEndpointManager.saveEndpoints([makeProfileEndpoint(vendor)]);
  let error: unknown;
  try {
    await request();
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.instanceOf(Error);
}

describe("Coding Plan LLM service boundary", function () {
  it("reports Coding Plan HTTP profiles as non-Base64 endpoints", function () {
    for (const vendor of HTTP_CODING_PLAN_VENDORS) {
      expect(
        LLMService.endpointSupportsPdfBase64(makeProfileEndpoint(vendor)),
      ).to.equal(false);
    }
  });

  for (const vendor of HTTP_CODING_PLAN_VENDORS) {
    it(`${vendor} summary rejects legacy, explicit-policy, and structured Base64 input before the provider`, async function () {
      const provider = ProviderRegistry.get("openai-compat");
      expect(provider).to.not.equal(undefined);
      const original = provider!.generateSummary;
      let providerCalls = 0;
      provider!.generateSummary = async () => {
        providerCalls += 1;
        return "unexpected provider call";
      };
      try {
        const requests = [
          {
            task: "summary" as const,
            content: {
              kind: "legacy" as const,
              content: "JVBERi0xLjQK",
              isBase64: true,
            },
          },
          {
            task: "summary" as const,
            content: {
              kind: "text" as const,
              text: "plain text",
              policy: "pdf-base64" as const,
            },
          },
          {
            task: "summary" as const,
            content: {
              kind: "pdf-files" as const,
              policy: "text" as const,
              files: [
                {
                  filePath: "/tmp/paper.pdf",
                  displayName: "paper.pdf",
                  textContent: "plain text",
                  base64Content: "JVBERi0xLjQK",
                },
              ],
            },
          },
        ];
        for (const request of requests) {
          await expectProfileInputRejected(vendor, () =>
            LLMService.generate({
              ...request,
              transport: { retry: false },
            }),
          );
        }
      } finally {
        provider!.generateSummary = original;
      }
      expect(providerCalls).to.equal(0);
    });

    it(`${vendor} chat rejects legacy, explicit-policy, and structured Base64 input before the provider`, async function () {
      const provider = ProviderRegistry.get("openai-compat");
      expect(provider).to.not.equal(undefined);
      const original = provider!.chat;
      let providerCalls = 0;
      provider!.chat = async () => {
        providerCalls += 1;
        return "unexpected provider call";
      };
      try {
        const requests = [
          {
            content: {
              kind: "legacy" as const,
              content: "JVBERi0xLjQK",
              isBase64: true,
            },
          },
          {
            content: {
              kind: "text" as const,
              text: "plain text",
              policy: "pdf-base64" as const,
            },
          },
          {
            content: {
              kind: "pdf-files" as const,
              policy: "text" as const,
              files: [
                {
                  filePath: "/tmp/paper.pdf",
                  displayName: "paper.pdf",
                  textContent: "plain text",
                  base64Content: "JVBERi0xLjQK",
                },
              ],
            },
          },
        ];
        for (const request of requests) {
          await expectProfileInputRejected(vendor, () =>
            LLMService.chat({
              ...request,
              conversation: [{ role: "user", content: "summarize" }],
              transport: { retry: false },
            }),
          );
        }
      } finally {
        provider!.chat = original;
      }
      expect(providerCalls).to.equal(0);
    });
  }

  it("passes Coding Plan and Claude CLI endpoint metadata through buildOptions", function () {
    const kimi = makeProfileEndpoint("kimi-code");
    expect(LLMService.buildOptions(kimi)).to.include({
      codingPlanVendor: "kimi-code",
      codingPlanProfile: "kimi-code",
    });

    const claude = {
      ...LLMEndpointManager.createEndpoint("claude-code-cli"),
      apiUrl: "https://unexpected.invalid",
      apiKey: "must-not-enter-an-api-request",
      claudeBinaryPath: "claude",
      claudePermissionMode: "plan",
      claudeRestricted: true,
      claudeOutputFormat: "stream-json",
    };
    expect(LLMService.buildOptions(claude)).to.include({
      apiUrl: "",
      apiKey: "",
      codingPlanVendor: "claude-code-cli",
      codingPlanProfile: "claude-code-cli",
      claudeBinaryPath: "claude",
      claudePermissionMode: "plan",
      claudeRestricted: true,
      claudeOutputFormat: "stream-json",
    });
  });

  it("keeps Claude CLI string options out of Anthropic API credentials", function () {
    const options = LLMService.buildOptions("claude-code-cli");

    expect(options).to.include({
      apiUrl: "",
      apiKey: "",
      model: "sonnet",
    });
    expect(LLMService.mapToKeyManagerId("claude-code-cli")).to.equal(
      "claude-code-cli",
    );
  });
});
