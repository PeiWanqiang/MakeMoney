# ProofTrade Web implementation rules

This repository is part of the parent `makemoney` project. Before changing product behavior, read and follow `../docs/GENERALIZATION_POLICY.md`.

## Mandatory release gate

- Implement reusable semantic primitives, never branches tied to exact user wording, constants, assets, timeframes, directions, languages, screenshots, or captured payloads.
- A model prompt saying a feature is supported is insufficient. The contract, validation, execution/backtest, UI explanation, cache/versioning, and tests must support the same semantics wherever applicable.
- Strategy changes require the reported regression, materially different parameter and structural variants, a boundary or rejection case, and the existing regression suite.
- Keep Backtest, Paper, and Live behavior aligned; do not add Web-only approximations.
- When semantics change, bump the affected strategy, artifact, result-cache, or engine version.
- If a capability cannot be generalized and executed safely, leave it explicitly unsupported and describe the missing reusable primitive.

Do not mark work complete until the acceptance checklist in `../docs/GENERALIZATION_POLICY.md` is satisfied.
