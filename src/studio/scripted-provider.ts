import type {
  StrategyProgramProvider,
  StrategyProviderRequest,
  StrategyProviderResponse,
} from "./types.js";

/** A deterministic provider for tests and offline product-loop demonstrations. */
export class ScriptedStrategyProgramProvider implements StrategyProgramProvider {
  readonly requests: StrategyProviderRequest[] = [];
  private readonly responses: StrategyProviderResponse[];

  constructor(responses: StrategyProviderResponse[]) {
    this.responses = [...responses];
  }

  async generate(request: StrategyProviderRequest): Promise<StrategyProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("The scripted strategy provider has no response left.");
    return response;
  }
}
