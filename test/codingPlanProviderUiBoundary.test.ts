import { expect } from "chai";
import { endpointProviderOptions } from "../src/modules/views/ui/EndpointSettingsPanel";

describe("Coding Plan endpoint UI boundary", function () {
  it("exposes Coding Plan profiles through the safe profile-aware picker", function () {
    const providerIds = endpointProviderOptions().map((option) => option.value);

    expect(providerIds).to.include("kimi-code");
    expect(providerIds).to.include("zhipu-glm-coding");
    expect(providerIds).to.include("claude-code-cli");
    expect(providerIds).to.include("codex-app-server");
  });
});
