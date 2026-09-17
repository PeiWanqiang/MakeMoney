# The internet strategy-intent corpus

English | [简体中文](INTERNET_INTENT_CORPUS.zh-CN.md)

Status: collection pipeline v0.1, implemented and validated on a small real-API
sample  
Goal: build a traceable, deduplicated, auditable candidate pool of
natural-language strategies from clearly licensed public internet content

## 1. What the data is, and is not

Public internet content is "real public phrasing by real people". It is not an
intent its author confirmed, and it never automatically becomes a golden answer.

Data passes through, in order:

```text
official API / clearly licensed repository
  -> raw candidate with provenance
  -> license gate
  -> strategy relevance scoring
  -> exact and near-duplicate removal
  -> human semantic review
  -> golden contract and behavioral scenarios
  -> frozen evaluation set
```

The code today produces the "deduplicated candidate set" and the "auditable human
annotation tooling". A candidate reaches a real evaluation set only after human
evidence annotation and adjudication.

## 2. Sources currently enabled

### Stack Exchange

- Uses the official Stack Exchange API `search/advanced`.
- The first pass covers Stack Overflow `pine-script` and Quantitative Finance
  Stack Exchange.
- Stores the question link, the attribution required, and the applicable CC BY-SA
  version.
- Saves data atomically and writes a checkpoint after each query page.

Licensing: <https://stackoverflow.com/help/licensing>

### GitHub

- Uses the official GitHub REST API to search public repositories and read
  READMEs.
- Accepts only `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`,
  `CC0-1.0`, and `Unlicense`.
- Rejects unlicensed repositories, unknown licenses, and archived repositories
  outright.
- The default queries require a README to contain rule-like phrasing such as
  Entry/Exit or Buy/Sell together, which cuts noise from generic framework
  repositories.
- `GITHUB_TOKEN` is optional; without it, the lower public API quota applies.

License API: <https://docs.github.com/en/rest/licenses/licenses>

## 3. Sources deliberately not collected automatically

- Reddit: commercial and AI-related data use needs additional permission, so it
  is not collected.
- TradingView: current terms strictly limit machine processing and content reuse,
  so it is used only for human topic discovery.
- X, YouTube, Discord, Telegram: excluded from the automated pipeline until the
  appropriate API, platform, or author permission is in place.

## 4. Record structure

Each JSONL record contains:

- A stable candidate ID, the source record ID, and the URL.
- Publication time, collection time, and source host.
- The raw relevant text and its SHA-256.
- Language, tags, relevance score, and the signals that triggered it.
- License, attribution text, and author provenance.
- GitHub repository, default branch, and README path.
- Human review status.

Contact details, emails, wallets, accounts, and trading credentials are not
collected fields. An author's display name is stored only to satisfy attribution
requirements.

## 5. Commands

```bash
# Stack Exchange: 4 query groups by default, up to 50 records each
npm run intents:collect-stackexchange -- --pages 1 --page-size 50

# GitHub: 4 strict README query groups by default; a token raises the API quota
GITHUB_TOKEN="..." npm run intents:collect-github -- --pages 1 --page-size 25

# Merge, re-score, and deduplicate across sources
npm run intents:filter -- --minimum-score 0.3 --near-threshold 0.9

# Generate a stratified 25-item queue for one independent reviewer
npm run intents:review -- queue --reviewer reviewer-1 --limit 25

# Formal review uses blind packages that hide source, score, and AI suggestions
npm run intents:review -- queue --reviewer reviewer-a --limit 25 --blind true
npm run intents:review -- queue --reviewer reviewer-b --limit 25 --blind true

# Check progress
npm run intents:review -- stats

# Generate read-only dual-lane DeepSeek suggestions for a review queue
npm run intents:suggest -- --limit 25 --concurrency 2
```

Default files:

```text
data/internet-intents/raw/stackexchange.jsonl
data/internet-intents/raw/github.jsonl
data/internet-intents/candidates/candidates.jsonl
data/internet-intents/candidates/summary.json
data/internet-intents/review/annotations.jsonl
data/internet-intents/review/queue-reviewer-1.json
data/internet-intents/golden/golden.jsonl
data/internet-intents/golden/manifest.json
```

The whole directory is Git-ignored. Re-running the same query reads the
checkpoint and does not re-request pages that already completed.

## 6. Completed small-sample validation

On 2026-07-30, using the unauthenticated GitHub API and the official Stack
Exchange API:

- Stack Exchange: the first three pages of several query groups, stored as 493
  records after merging by source ID.
- GitHub: two small passes examined 40 search results, of which 10 unique
  repositories passed the license allowlist; the rest were rejected mostly for
  having no clear license.
- 503 raw records across both sources; 495 candidates after the relevance
  threshold.
- Candidate provenance: 486 from Stack Exchange, 9 from GitHub.
- Licenses: 485 CC BY-SA 4.0, 1 CC BY-SA 3.0, 9 MIT.
- Rule-based scoring marked 472 candidates highly relevant and 23 possibly
  relevant; the median text length is about 1,159 characters.
- Re-running hit the checkpoint every time, with no duplicate requests.

None of those 495 have been human-reviewed, and they must not be reported as
"495 real golden strategies".

## 7. Review and golden-set quality gates

Every queue record carries a read-only `candidate` and a `review` to be filled
in. A reviewer must:

1. Leave `candidateId` and `candidateSha256` unchanged.
2. Set `status` to `submitted` and fill `submittedAt` in ISO format.
3. Choose `ready`, `needs_clarification`, `unsupported`, or `not_strategy`.
4. Annotate at least one evidence span from the original text. `quote` must equal
   `rawText.slice(start, end)` character for character, and `supports` states
   which fact that span supports.
5. For `ready`, provide the normalized intent and a `StrategyContract`. When a
   key parameter is missing, mark it `needs_clarification` and write the
   question; when the engine cannot express it, mark it `unsupported` and list
   the capability gap.

Save a single `review` object as JSON and submit it:

```bash
npm run intents:review -- submit --file review.json
```

Different reviewers submit independently under different `reviewerId` values. An
adjudicator uses the same structure with `kind` set to `adjudication`, listing
the independent review IDs consulted in `basedOnReviewIds`. When a new
independent opinion is submitted, the old adjudication is invalidated
automatically, so no adjudication rests on stale opinions.

Once both reviews are in, the tooling computes disposition agreement, full
decision agreement, and Cohen's kappa, and generates an identity-blinded
adjudication package:

```bash
npm run intents:review -- agreement --reviewer-a reviewer-a --reviewer-b reviewer-b
npm run intents:review -- adjudication-queue --adjudicator adjudicator-1
```

The adjudication package puts disputed cases first, hides reviewer identity and
source metadata, and pre-fills every `basedOnReviewIds`.

The formal golden set requires at least two distinct reviewers and one
adjudication by default:

```bash
npm run intents:review -- export
```

Once a golden set exists, the whole-engine evaluation runs on the development
split only by default:

```bash
npm run intents:evaluate -- --split development --concurrency 2
```

The evaluation checks the first action, the ready contract, the program's reverse
semantics, the behavioral scenarios, and the mutation kill rate. Actions for
`needs_clarification` and `unsupported` can be checked automatically, but whether
the question or capability description is semantically right stays a human
review and does not count as a strict pass. The blind split requires an explicit
`--allow-blind true`, so everyday debugging cannot accidentally look at frozen
samples.

A single-person pilot, used only to validate the workflow, must lower the bar
explicitly:

```bash
npm run intents:review -- export --minimum-reviewers 1 --require-adjudication false
```

Export re-verifies the source SHA, the evidence spans, the status fields, and the
contract structure. `not_strategy` stays in the annotation record as a filtering
basis but never enters the golden strategy set. Development, validation, and
blind splits are grouped by author; GitHub content is grouped by repository, so
no author or repository leaks across splits. The export manifest records the
quality bar, the counts per category, and the SHA-256 of the whole JSONL.

This process validates that "the golden answer really comes from the user's own
words". It cannot prove a translation is correct from one backtest return alone.
Evaluation must still check all of: differences from the golden contract, the
static semantics of the generated code, deterministic behavioral scenarios, and
mutation testing.

### Dual-lane AI suggestions

`intents:suggest` first uses deterministic rules to split mixed content into a
prose lane and a code lane, then calls DeepSeek on each independently. Each lane
can return any of the four dispositions, evidence from the original text, a
missing-information question, or a suggested contract. The system writes those
suggestions only to:

```text
data/internet-intents/review/suggestions.jsonl
```

It never writes to `annotations.jsonl`, and there is no code path that submits a
suggestion as a review. Every quote in a suggestion must still exist character
for character in the candidate's original text. If the model rewrites a quote,
returns an illegal status, or produces an invalid contract, that lane is marked
`error`, the command exits with a failure status, and the next run retries it.
When the two lanes disagree on disposition or contract, the item is marked
`conflict` and is never merged automatically. When one lane has too little text,
it is `unavailable` and the item is `insufficient`.

On 2026-07-30 a minimal trial ran on the first three items of a real queue: one
had only a prose suggestion; one had its code lane rejected by the quality gate
for a non-verbatim quote, then passed after a checkpointed retry; one Pine
debugging sample produced a disposition conflict between the prose and code
lanes. The final tally was 1 agree, 1 conflict, 1 insufficient, and 0 lane
errors. That shows the layer can surface ambiguity in mixed text, but these
results are still not human review and not golden labels.

## 8. Next stage

1. Grow to roughly 2,000 candidates, and add clearly licensed Chinese sources.
2. Run independent dual-lane semantic extraction over natural language and any
   accompanying code, as a reference for reviewers rather than a golden answer.
3. Complete two independent human reviews of 250 items with adjudication of
   disputes, yielding roughly 150 golden records.
4. Run the current V4 evaluator against the real internet corpus, reporting high,
   medium, and low confidence results separately.
