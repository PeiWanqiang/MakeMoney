# Project-wide implementation rules

These rules apply to the entire `makemoney` workspace, including the independent `web/` repository.

## Generalization is a release gate

Before implementing or approving any change, read and follow `docs/GENERALIZATION_POLICY.md`.

- Implement reusable product, engineering, and business capabilities, never input-specific patches or single-customer conclusions.
- Do not branch on a user's exact wording, example constants, asset, timeframe, language, or one captured payload unless that value is an actual product rule.
- A prompt change does not constitute feature support. Strategy capabilities must be represented and validated through the full applicable path: intent, contract/types, compiler or validator, runtime/backtest, product explanation, persistence/versioning, and tests.
- Every capability change needs the reported regression plus materially different variants and at least one boundary or rejection case.
- Backtest, Paper, and Live semantics must share the same versioned capability; do not create mode-specific approximations.
- If a request cannot yet be generalized safely, keep it explicitly unsupported and record the missing reusable primitive.

The acceptance checklist in `docs/GENERALIZATION_POLICY.md` is mandatory for implementation tasks.
