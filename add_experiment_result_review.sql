-- add_experiment_result_review.sql
-- Human-in-the-loop calibration for the Evaluation system: lets a
-- reviewer mark agree/disagree on a saved ExperimentResult's automated
-- verdict. Additive only -- never overwrites `passed`/`scores`. No
-- reviewer-identity column: this app's other dashboard review actions
-- (e.g. PATCH /traces/{id}/flags/{id}) don't attribute to a specific
-- logged-in user either, since the dashboard's data-plane calls all
-- authenticate via the project's API key, not a human login session.

ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS human_verdict BOOLEAN;
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
