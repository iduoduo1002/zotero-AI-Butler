import { expect } from "chai";
import { endpointProviderOptions } from "../src/modules/views/ui/EndpointSettingsPanel";

describe("Coding Plan endpoint UI boundary", function () {
  it("does not expose Claude CLI in the generic endpoint picker before its safe UI exists", function () {
    const providerIds = endpointProviderOptions().map((option) => option.value);

    expect(providerIds).to.not.include("claude-code-cli");
    expect(providerIds).to.include("codex-app-server");
  });
});
