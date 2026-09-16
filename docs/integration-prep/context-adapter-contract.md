# Context adapter contract

## What this is

A frontend-only, pure validation layer (`www/context-adapter.js`) that
defines exactly what "page context" a future LinguaHub page may safely
hand to the assistant, and rejects everything else. **Nothing in this
repository calls it with real data today** - no fake values, no sample
context, no auto-populated example. It exists so the *shape* of safe
context is defined, tested, and ready before any real integration writes
code against it.

This is the frontend counterpart to the backend contract already defined
in [../linguahub-ai-integration-handoff.md](../linguahub-ai-integration-handoff.md)
("What page context may safely be included" / "What must never be
included"). That document's rules are restated here as an enforceable
allowlist rather than prose, but the underlying policy is the same one,
not a new one.

## Frontend context is never authoritative

This is the load-bearing rule of the whole contract: `validate()` is a
**client-side courtesy filter**, not a security boundary. Whatever a
future LinguaHub page sends with a real chat request, the **backend must
independently re-validate it** - this module makes no claim about, and
does not change, server-side trust boundaries. `lib/aiModes.js` and
`lib/contextBuilder.js` are both completely untouched by this phase.

## Allowed fields

Exactly these twelve, and no others - a field is not on this list merely
because it might be useful someday:

| Field | Example |
|---|---|
| `source` | `"linguahub"` |
| `route` | `"/lessons/12/quiz"` |
| `module` | `"Past Tense Verbs"` |
| `pageType` | `"reading"` |
| `language` | `"en"` |
| `userRole` | `"student"` |
| `testId` | `"cambridge-18"` |
| `sectionId` | `"reading-1"` |
| `questionId` | `"q17"` |
| `attemptId` | `"attempt-9"` |
| `submitted` | `true` |
| `resultSummary` | `"3 of 5 correct"` |

Every value must be a flat primitive (`string`/`number`/`boolean`/`null`)
- a nested object or array on an otherwise-allowed key (e.g.
`resultSummary: { score: 3, hiddenAnswerKey: "B" }`) is rejected outright,
because a flat key-name allowlist alone can't see what's smuggled one
level down inside a permitted key.

## Forbidden fields

Rejected unconditionally, by name-pattern match, even if spelled to look
like something else: anything matching `token`, `secret`, `key`,
`password`, `credential`, `apikey`, `answerkey`, `correctanswer`,
`hiddenanswer`, `adminnote`, `evaluatornote`, `systemprompt`, or
`env`/`environ` (case-insensitive). This directly encodes the backend
document's own "what must never be included" list: hidden correct
answers, admin/evaluator-only notes, secrets/tokens/keys, environment
variables, system prompts.

Any field not on the allowed list at all - forbidden-looking or not - is
also rejected. The allowlist, not the forbidden-pattern list, is the real
gate; the forbidden-pattern match exists to fail loudly and specifically
when a caller clearly tried to pass one of these, rather than lumping it
in with an ordinary "unrecognized field" rejection.

## API

```js
LinguaHubContextAdapter.validate(rawContext);
// -> { ok: true, context: {...allowed fields only...}, rejectedFields: [...], reason }

LinguaHubContextAdapter.isEmptyContext(context);
// -> true if context has no real fields

LinguaHubContextAdapter.formatChipLabel(context);
// -> "Reading · Cambridge 18 · Q17" style string, or null if nothing to show

LinguaHubContextAdapter.applyContext(rawContext);
// -> validates, then updates #context-chip-text / .context-chip's
//    has-context class - the one DOM-touching function in this module.
//    Falls back to the existing honest "No active context" default when
//    there is nothing valid to show.
```

`validate()`/`isEmptyContext()`/`formatChipLabel()` are pure - no DOM
access, directly unit-tested with `require()` like this project's other
pure modules (`www/config.js`, `www/app-mode.js`). `applyContext()` is the
one function that touches the real context chip elements
(`#context-chip`/`#context-chip-text`, unchanged since Phase 13/14).

## Why nothing calls `applyContext()` yet

Because there is no real LinguaHub page context to call it with. Calling
it with fabricated/sample data would violate this phase's explicit "no
fake values" and "do not connect real LinguaHub data yet" constraints.
The context chip continues to show its existing honest default,
`"No active context"`, exactly as before this phase.

## Future integration examples (illustrative only - not implemented)

```js
// A future LinguaHub-side bridge, once real page context exists:
LinguaHubContextAdapter.applyContext({
  source: "linguahub",
  route: "/reading/cambridge-18/test-3",
  module: "Reading",
  testId: "Cambridge 18",
  questionId: "Q17",
  language: "en",
  userRole: "student"
});
// -> chip shows "Reading · Cambridge 18 · Q17"
```

The three examples named in the product brief this phase was scoped
against:

- `Reading · Cambridge 18 · Q17`
- `Writing · Task 2 · Band 6.5`
- `Speaking · Part 2 · Result`

all fall directly out of `formatChipLabel()`'s existing field-priority
logic (`module`, `testId`, `questionId`, `pageType`, `resultSummary`, in
that order, skipping absent fields) - no special-casing needed per
example.

## Testing

`tests/context-adapter.test.js` - 11 tests covering: empty/absent context,
non-object input, every allowed field passes through, every forbidden
field is rejected (individually asserted, not just "some were rejected"),
unrecognized fields are rejected, nested object/array values are rejected
even on allowed keys, `isEmptyContext`/`formatChipLabel` behavior,
and that `formatChipLabel` never leaks a forbidden field into the visible
label even when called with unvalidated input directly.
