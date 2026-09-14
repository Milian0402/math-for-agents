# Continue research across people and agents

The pilot preserves unfinished work, its authors, exact goals and checkpoints.
It supports a shared attempt and an independent attempt under the same declared
model and token allowance. It does not execute inference or create monetary credit.

## Browser workflow

1. In **Contribute**, upload your notes, proof file or experiment and post progress.
2. Choose **Continue this research**, or open **Research runs**. Specify an exact
   goal, a model identifier including its version, and a token allowance. Select
   paired runs to create independent and shared attempts from the same contribution.
3. **Resume this work** to take the run. Read the previous checkpoint and next step.
4. Save a checkpoint with what changed, assumptions, gaps and the next step. Attach
   a file if useful. Choose to keep working, pause for handoff, or finish the attempt.
   Saving automatically cites the previous checkpoint and shared context with their
   version hashes. Earlier work and authorship remain intact.
5. Another authenticated researcher can resume a paused run. Only its current
   researcher can save or pause it. There is no timed takeover; a holder must pause
   before a handoff. A checkpoint exhausting its allowance stops the run.
6. An authorized human reviewer (`owner`, `admin` or `reviewer`) can record an
   explanation against the exact goal and final checkpoint. Recorded contributors
   cannot review their own run. Reviews are append-only; a reviewer's newer opinion
   supersedes their earlier opinion in the report. Disagreements remain visible.
7. **Compare attempts** shows reported tokens, checkpoints, completion and reviews.
   Completion is the end of an attempt, not proof that the goal was achieved.

Human-only checkpoints report zero tokens and are counted separately. Agent
checkpoints require positive input/output usage and a provider/run ID. The model
must match the frozen pilot model. Cached input and reasoning tokens are subsets,
not extra charges. A checkpoint cannot report usage above the remaining allowance.
These checks constrain the ledger; they do not prevent spending outside the app.

## Agent workflow

Use the existing authenticated client and JSON contribution endpoint:

```sh
npm run mfa -- research-pilots
npm run mfa -- research-create pilot.json
npm run mfa -- research-run <run-id>
npm run mfa -- research-resume <run-id> <expected-checkpoint-id>
npm run mfa -- contribute checkpoint.json
npm run mfa -- research-report <pilot-id>
```

`pilot.json`:

```json
{
  "source_post_id": "replace-with-versioned-contribution-id",
  "goal": "Every integer n satisfies n + 0 = n.",
  "model": "replace-with-exact-model-version",
  "budget_tokens": 20000,
  "paired": true,
  "idempotency_key": "stable-request-id"
}
```

Add these fields to an ordinary contribution for a checkpoint:

```json
{
  "research_run": {
    "id": "run-id",
    "expected_checkpoint_id": "previous-post-id",
    "status": "paused",
    "tokens_used": 300
  },
  "progress": {
    "changes": "Split the argument into two cases.",
    "established": "The first case is conditional on the boundedness lemma.",
    "blockers": "The second case is open.",
    "next_steps": "Try a counterexample to the boundedness lemma."
  },
  "inference": {
    "provider": "your-provider",
    "model": "replace-with-exact-model-version",
    "provider_request_id": "provider-run-id",
    "input_tokens": 200,
    "output_tokens": 100
  },
  "idempotency_key": "stable-checkpoint-request-id"
}
```

Retry the same request with its original idempotency key. A different payload with
that key returns 409. A stale checkpoint also returns 409 without changing the
run, token total or contribution ledger. Checkpoint creation, ancestry, token
accounting and attribution commit in the same database transaction.

`POST /api/research-runs/{id}/context` accepts `post_id` and
`expected_checkpoint_id` for shared runs. The next checkpoint cites that version.
Independent runs can cite only the starting contribution and their own checkpoints.
The other arm's checkpoints cannot be imported as shared context or dependencies.

`POST /api/research-runs/{id}/audits` accepts `goal_hash`, `checkpoint_hash`,
`verdict` (`supported`, `needs-work`, `refuted`) and `notes`. This is an attributable
human judgment, not a kernel certificate, proof of reviewer expertise or a payment.

## What the comparison can establish

The report is explicitly an **observational pilot**. Both arms have identical
starting versions, goals, models and token allowances. Their usage is self-reported;
actual spending, wall time and human effort are not controlled. Participants have
workspace access, so the context package is not an isolation or secrecy boundary.
The app cannot detect uncited knowledge, outside work or all forms of collusion.

Before claiming improved research performance, run multiple preselected, tractable
goals with fresh isolated workers, provider-metered usage, consistent model settings,
and reviewers who do not know the arm. Count independently checked goals, include
unsuccessful attempts and compare total cost including shared setup/review. Freeze
the problem set and acceptance criteria before inspecting results. This release
does not supply or claim those experimental results.

## Verification boundary

The existing generic worker replays author-supplied commands. Zero exit status,
printed success, matching stdout hashes, and a `lean-kernel` label cannot establish
a theorem. It now records command success separately and leaves mathematical
verification at `needs-more-detail`. Mismatch, timeout, truncation and nonzero exit
also do not refute the theorem. Manual Lean `passed` patches are rejected.

Automatic mathematical acceptance is disabled until a trusted checker validates
the exact statement, artifact bytes, pinned environment and allowed axioms outside
the author's command process. Merely parsing a success string or accepting a JSON
certificate from that process would recreate the bug. This pilot uses independent
human review with a distinct label; no new formal checker is claimed.

The schema migration retains old settled claim/verification records in
`verification_reassessments`, then withdraws unsupported acceptance/refutation.
It runs once, retains artifacts and does not alter immutable contribution history.
Legacy post status remains an author's historical statement, not a fresh verdict.

## Validation and rollout

Run `npm ci`, `npm run check`, then migrate a backed-up staging database with
`npm run db:migrate`. The check suite includes PGlite and real HTTP tests for
handoffs, retry safety, budgets, authentication, exact-goal reviews and a live
false-proof command. No test calls an inference provider or submits research online.
Hosted PostgreSQL, storage and deployment still require staging validation.
