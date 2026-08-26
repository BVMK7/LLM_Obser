-- add_scorer_types.sql
-- Deterministic (non-LLM) scorer types alongside the existing implicit
-- LLM-judge scorer type: pattern_match (regex or substring match against a
-- Scorer's output) and json_valid (does the output parse as valid JSON via
-- Python's stdlib json.loads -- no JSON Schema validation). See
-- _run_custom_scorer's scorer_type dispatch in main.py.
--
-- prompt_template/choice_scores were NOT NULL because every scorer used to
-- be an LLM judge; a pattern_match/json_valid scorer has no prompt and no
-- choice-label mapping, so those two columns must become nullable at the
-- DB level. The per-type "this field is required for this type" rule is
-- enforced at the Pydantic layer (ScorerCreate.model_validator in main.py),
-- not a DB CHECK constraint -- this table predates scorer_type, and
-- ALTER TABLE ... ADD CONSTRAINT is not safely re-runnable (a second run
-- errors "constraint already exists"), which would break this repo's hard
-- idempotency requirement for migrations. DROP NOT NULL, by contrast, is
-- naturally idempotent: running it twice against an already-nullable
-- column is a silent no-op.

ALTER TABLE scorers ALTER COLUMN prompt_template DROP NOT NULL;
ALTER TABLE scorers ALTER COLUMN choice_scores DROP NOT NULL;
ALTER TABLE scorers ADD COLUMN IF NOT EXISTS scorer_type TEXT NOT NULL DEFAULT 'llm_judge';
ALTER TABLE scorers ADD COLUMN IF NOT EXISTS pattern TEXT;
ALTER TABLE scorers ADD COLUMN IF NOT EXISTS pattern_is_regex BOOLEAN NOT NULL DEFAULT false;
