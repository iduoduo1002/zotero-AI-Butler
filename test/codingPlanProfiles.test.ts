import { expect } from "chai";
import {
  getCodingPlanProfile,
  listCodingPlanProfiles,
} from "../src/modules/codingPlanProfiles";

describe("Coding Plan profiles", function () {
  it("exposes the exact vendor catalog and defaults", function () {
    expect(listCodingPlanProfiles().map((profile) => profile.id)).to.deep.equal(
      ["kimi-code", "zhipu-glm-coding", "claude-code-cli"],
    );

    expect(getCodingPlanProfile("kimi-code")).to.include({
      id: "kimi-code",
      label: "Kimi Code",
      protocol: "openai-chat",
      defaultApiUrl: "https://api.kimi.com/coding/v1/chat/completions",
      defaultModel: "kimi-for-coding",
      requiresApiKey: true,
      supportsStreaming: true,
      supportsPdfBase64: false,
    });
    expect(getCodingPlanProfile("zhipu-glm-coding")).to.include({
      id: "zhipu-glm-coding",
      label: "GLM Coding Plan",
      protocol: "openai-chat",
      defaultApiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      defaultModel: "glm-5.3",
      requiresApiKey: true,
      supportsStreaming: true,
      supportsPdfBase64: false,
    });
    expect(getCodingPlanProfile("claude-code-cli")).to.include({
      id: "claude-code-cli",
      label: "Claude Code CLI",
      protocol: "claude-cli",
      defaultModel: "sonnet",
      requiresApiKey: false,
      supportsStreaming: true,
      supportsPdfBase64: false,
    });
  });

  it("returns immutable catalog entries and rejects unknown profiles", function () {
    const profiles = listCodingPlanProfiles();
    const kimi = getCodingPlanProfile("kimi-code");

    expect(Object.isFrozen(profiles)).to.equal(true);
    expect(kimi).to.not.equal(undefined);
    expect(Object.isFrozen(kimi)).to.equal(true);
    expect(getCodingPlanProfile("not-a-profile")).to.equal(undefined);
  });
});
