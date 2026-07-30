"""
Minimal FastAPI + SQLAlchemy app for the llm_observability database.
Run with: uvicorn main:app --reload
"""

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict
from sqlalchemy import create_engine, Column, String, Text, DateTime, Integer, Numeric, ForeignKey, Boolean, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import declarative_base, sessionmaker, Session, relationship

from providers import PROVIDERS, MODEL_CATALOG, estimate_cost

ProviderName = Literal["gemini", "groq", "openrouter"]

# 1. Load environment variables from .env (this is where DATABASE_URL lives)
load_dotenv()
DATABASE_URL = os.environ["DATABASE_URL"]

# 2. Database connection setup.
# "psycopg2" is the driver SQLAlchemy uses under the hood to talk to Postgres.
# The engine manages the actual connections; SessionLocal gives us a new
# database session (a "conversation" with the DB) each time we need one.
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
Base = declarative_base()


def get_db():
    """FastAPI dependency: opens a DB session for a request, closes it when done."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# 3. SQLAlchemy model — this maps the "traces" table to a Python class.
# Each class attribute below corresponds to one column in the table.
class Trace(Base):
    __tablename__ = "traces"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    name = Column(String, nullable=False)
    input = Column(Text)
    output = Column(Text)
    started_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    ended_at = Column(DateTime(timezone=True))
    total_tokens = Column(Integer)
    cost = Column(Numeric(10, 6))
    # Which literal model string was used (e.g. "llama-3.1-8b-instant") — set
    # by Playground (see run_playground below); NULL for older rows and
    # anything posted directly to POST /traces without one.
    model = Column(String)
    # Manual human-review workflow: a reviewer flags a trace for a second look
    # (e.g. off the back of a bad user_feedback score) and can leave a note.
    flagged_for_review = Column(Boolean, nullable=False, server_default="false")
    review_note = Column(Text)

    # Lets us access trace.spans / trace.scores in Python; SQLAlchemy loads
    # them with a second query the first time they're accessed.
    spans = relationship("Span", order_by="Span.started_at")
    scores = relationship("Score", order_by="Score.created_at")


# SQLAlchemy model for the "spans" table — one row per step within a trace.
class Span(Base):
    __tablename__ = "spans"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    trace_id = Column(UUID(as_uuid=True), ForeignKey("traces.id", ondelete="CASCADE"), nullable=False)
    # Self-reference lets a span nest under another span in the same trace
    # (e.g. a scorer's judge call nested under the LLM call it's judging) —
    # NULL means "root span, directly under the trace."
    parent_span_id = Column(UUID(as_uuid=True), ForeignKey("spans.id", ondelete="CASCADE"))
    step_name = Column(String, nullable=False)
    input = Column(Text)
    output = Column(Text)
    started_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    ended_at = Column(DateTime(timezone=True))
    error = Column(Text)               # raw error message, if this step failed
    error_explanation = Column(Text)   # plain-language explanation of the error, filled in automatically


# SQLAlchemy model for the "scores" table — an LLM-judged score for a trace
# (e.g. "relevance" or "accuracy"), with a short explanation of why it was given.
class Score(Base):
    __tablename__ = "scores"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    trace_id = Column(UUID(as_uuid=True), ForeignKey("traces.id", ondelete="CASCADE"), nullable=False)
    score_name = Column(String, nullable=False)
    score_value = Column(Numeric, nullable=False)
    explanation = Column(Text)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")


# SQLAlchemy model for the "datasets" table — a named, reusable set of eval
# test cases. `cases` is a JSONB blob (a list of {id, question, expected}
# objects) rather than a join table: cases have no independent DB-level needs
# (no per-case timestamps/status), and this shape matches the frontend's
# in-memory case list exactly, so loading a saved dataset into the Evaluation
# page is a direct assignment, not a mapping step.
class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    name = Column(String, nullable=False)
    description = Column(Text)
    cases = Column(JSONB, nullable=False, server_default="[]")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default="now()", onupdate=func.now())


# SQLAlchemy model for the "prompts" table — a saved, reusable system-prompt
# template for the Playground page.
class Prompt(Base):
    __tablename__ = "prompts"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    name = Column(String, nullable=False)
    category = Column(String, nullable=False, server_default="system")
    content = Column(Text, nullable=False)
    tags = Column(Text)
    usage_count = Column(Integer, nullable=False, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default="now()", onupdate=func.now())


# SQLAlchemy model for the "prompt_versions" table — a snapshot of a Prompt's
# content taken every time it's saved, so Prompt Library can show history
# instead of a silent overwrite.
class PromptVersion(Base):
    __tablename__ = "prompt_versions"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    prompt_id = Column(UUID(as_uuid=True), ForeignKey("prompts.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    category = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    tags = Column(Text)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")


# SQLAlchemy model for the "scorers" table — a user-defined LLM-judge rubric:
# a prompt template (with {{input}}/{{output}}/{{expected}} placeholders) plus
# a mapping from the judge's chosen label to a 0-1 score.
class Scorer(Base):
    __tablename__ = "scorers"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    name = Column(String, nullable=False)
    slug = Column(String, nullable=False, unique=True)
    description = Column(Text)
    prompt_template = Column(Text, nullable=False)
    choice_scores = Column(JSONB, nullable=False, server_default="{}")
    pass_threshold = Column(Numeric, nullable=False, server_default="0.5")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default="now()", onupdate=func.now())


# SQLAlchemy model for the "experiments" table — a named, persisted snapshot
# of an Evaluation run, so results survive after the page is closed and two
# runs can be diffed against each other.
class Experiment(Base):
    __tablename__ = "experiments"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    name = Column(String, nullable=False)
    description = Column(Text)
    dataset_id = Column(UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="SET NULL"))
    providers = Column(JSONB, nullable=False, server_default="[]")
    scorer_slugs = Column(JSONB, nullable=False, server_default="[]")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")

    results = relationship("ExperimentResult", order_by="ExperimentResult.created_at")


# SQLAlchemy model for the "experiment_results" table — one row per
# (case, provider) result within an experiment, mirroring EvalCaseResult's
# shape plus a free-form `scores` map so any scorer (built-in judge or a
# custom Scorer) can contribute a named score without a schema change.
class ExperimentResult(Base):
    __tablename__ = "experiment_results"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    experiment_id = Column(UUID(as_uuid=True), ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False)
    question = Column(Text, nullable=False)
    expected = Column(Text)
    provider = Column(String, nullable=False)
    model = Column(String)
    answer = Column(Text, nullable=False)
    passed = Column(Boolean)
    scores = Column(JSONB, nullable=False, server_default="{}")
    input_tokens = Column(Integer, nullable=False, server_default="0")
    output_tokens = Column(Integer, nullable=False, server_default="0")
    total_tokens = Column(Integer, nullable=False, server_default="0")
    cost = Column(Numeric(10, 6), nullable=False, server_default="0")
    latency_ms = Column(Integer, nullable=False, server_default="0")
    trace_id = Column(UUID(as_uuid=True), ForeignKey("traces.id", ondelete="SET NULL"))
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")


# SQLAlchemy model for the "alert_rules" table — a threshold rule evaluated
# against real trace data (see GET /alerts/status), not a notification/paging
# integration — there's no email/Slack infra in this app, so a rule "firing"
# means it shows up flagged in the Alerts page.
class AlertRule(Base):
    __tablename__ = "alert_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default="gen_random_uuid()")
    name = Column(String, nullable=False)
    metric = Column(String, nullable=False)         # "error_rate" | "p95_latency_ms" | "avg_cost_per_request"
    comparator = Column(String, nullable=False)      # ">" | "<"
    threshold = Column(Numeric, nullable=False)
    window_minutes = Column(Integer, nullable=False, server_default="60")
    enabled = Column(Boolean, nullable=False, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default="now()")


# 4. Pydantic schemas — these define what JSON the API accepts and returns.
# TraceCreate = the shape of the request body sent to POST /traces.
class TraceCreate(BaseModel):
    name: str
    input: Optional[str] = None
    output: Optional[str] = None
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    total_tokens: Optional[int] = None
    cost: Optional[float] = None
    model: Optional[str] = None


# TraceResponse = the shape of the JSON we send back (includes DB-generated fields).
class TraceResponse(TraceCreate):
    id: uuid.UUID
    started_at: datetime
    # Computed, not a DB column — see _compute_trace_status() below.
    status: Literal["success", "error", "pending"]
    flagged_for_review: bool = False
    review_note: Optional[str] = None

    # Lets Pydantic read values directly off the SQLAlchemy Trace object.
    model_config = ConfigDict(from_attributes=True)


# SpanCreate = the shape of the request body sent to POST /spans.
class SpanCreate(BaseModel):
    trace_id: uuid.UUID
    step_name: str
    input: Optional[str] = None
    output: Optional[str] = None
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    error: Optional[str] = None  # raw error message — set this if the step failed
    # Nests this span under another span in the same trace; None = root span.
    parent_span_id: Optional[uuid.UUID] = None


# SpanResponse = the shape of the JSON we send back (includes DB-generated fields).
class SpanResponse(SpanCreate):
    id: uuid.UUID
    started_at: datetime
    # Plain-language explanation of `error`, generated automatically — never sent by the caller.
    error_explanation: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


# ScoreCreate = the shape of the request body sent to POST /scores.
class ScoreCreate(BaseModel):
    trace_id: uuid.UUID
    score_name: str
    score_value: float
    explanation: Optional[str] = None


# ScoreResponse = the shape of the JSON we send back (includes DB-generated fields).
class ScoreResponse(ScoreCreate):
    id: uuid.UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# TraceWithSpans = a trace plus all of its spans and scores — for GET /traces/{id}.
class TraceWithSpans(TraceResponse):
    spans: list[SpanResponse] = []
    scores: list[ScoreResponse] = []


# TraceFlagUpdate = the shape of the request body sent to PATCH /traces/{id}/flag.
class TraceFlagUpdate(BaseModel):
    flagged_for_review: bool
    review_note: Optional[str] = None


# EvalCase — one test case (question + optional expected keyword). Defined
# here (rather than down in the Evaluation section, where it conceptually
# lives) so the Dataset schemas below can reuse it directly: a saved
# Dataset's `cases` and an Evaluation run's `cases` are the exact same shape,
# so loading a dataset into the Evaluation page is a straight assignment, not
# a mapping step. `id` is optional and client-generated (crypto.randomUUID()
# on the frontend) — it gives each case stable identity for free without a
# join table, in case a later feature needs per-case operations (reorder,
# delete-one) that array position alone can't support.
class EvalCase(BaseModel):
    id: Optional[str] = None
    question: str
    expected: Optional[str] = None


# DatasetCreate/Update — what the client sends to save a dataset.
class DatasetCreate(BaseModel):
    name: str
    description: Optional[str] = None
    cases: list[EvalCase] = []


# DatasetListItem — the shape returned by the list endpoint. Omits `cases`
# (just a count) so listing datasets doesn't pull every dataset's full JSONB
# blob — same list/detail split GET /traces vs GET /traces/{id} already uses.
class DatasetListItem(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str] = None
    case_count: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# DatasetResponse — the full shape returned by the detail/create/update
# endpoints, including all cases.
class DatasetResponse(DatasetCreate):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# PromptCreate/Update — what the client sends to save a prompt template.
class PromptCreate(BaseModel):
    name: str
    category: str = "system"
    content: str
    tags: Optional[str] = None


class PromptResponse(PromptCreate):
    id: uuid.UUID
    usage_count: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# PromptVersionResponse — one snapshot from a prompt's history. Never created
# directly by a client; written server-side every time PUT /prompts/{id} saves.
class PromptVersionResponse(BaseModel):
    id: uuid.UUID
    prompt_id: uuid.UUID
    name: str
    category: str
    content: str
    tags: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ScorerCreate/Update — a user-defined LLM-judge rubric. `prompt_template` may
# reference {{input}}, {{output}}, {{expected}} — substituted at run time.
# `choice_scores` maps the judge's chosen label to a 0-1 score, e.g.
# {"Yes": 1.0, "Partially": 0.5, "No": 0.0} (mirrors Braintrust's "choice
# scores" concept: a judge picks a label, not a raw float, which is far more
# reliable to parse out of an LLM response than asking it for a bare number).
class ScorerCreate(BaseModel):
    name: str
    description: Optional[str] = None
    prompt_template: str
    choice_scores: dict[str, float]
    pass_threshold: float = 0.5


class ScorerResponse(ScorerCreate):
    id: uuid.UUID
    slug: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# AlertRuleCreate/Update — a threshold rule checked against real trace data
# within a trailing window (see _evaluate_alert_rule below).
class AlertRuleCreate(BaseModel):
    name: str
    metric: Literal["error_rate", "p95_latency_ms", "avg_cost_per_request"]
    comparator: Literal[">", "<"]
    threshold: float
    window_minutes: int = 60
    enabled: bool = True


class AlertRuleResponse(AlertRuleCreate):
    id: uuid.UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# AlertStatus — a rule plus its live-computed current value and whether it's
# currently triggered. Never persisted — computed fresh on every request.
class AlertStatus(BaseModel):
    rule: AlertRuleResponse
    current_value: Optional[float]
    triggered: bool
    sample_size: int


# ExperimentResultIn — one (case, provider) result the client already has in
# memory from a just-finished Evaluation run; POST /experiments persists a
# whole batch of these in one call ("Save as Experiment").
class ExperimentResultIn(BaseModel):
    question: str
    expected: Optional[str] = None
    provider: str
    model: Optional[str] = None
    answer: str
    passed: Optional[bool] = None
    scores: dict[str, float] = {}
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost: float = 0.0
    latency_ms: int = 0
    trace_id: Optional[uuid.UUID] = None


class ExperimentResultResponse(ExperimentResultIn):
    id: uuid.UUID
    experiment_id: uuid.UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ExperimentCreate(BaseModel):
    name: str
    description: Optional[str] = None
    dataset_id: Optional[uuid.UUID] = None
    providers: list[str] = []
    scorer_slugs: list[str] = []
    results: list[ExperimentResultIn] = []


# ExperimentListItem — the shape returned by the list endpoint. Omits the
# (potentially large) results array, same list/detail split as Datasets/Traces.
class ExperimentListItem(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str] = None
    dataset_id: Optional[uuid.UUID] = None
    providers: list[str]
    scorer_slugs: list[str]
    created_at: datetime
    result_count: int
    pass_rate: Optional[float] = None

    model_config = ConfigDict(from_attributes=True)


class ExperimentResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str] = None
    dataset_id: Optional[uuid.UUID] = None
    providers: list[str]
    scorer_slugs: list[str]
    created_at: datetime
    results: list[ExperimentResultResponse]

    model_config = ConfigDict(from_attributes=True)


# 5. The FastAPI app itself.
app = FastAPI()

# Allow the React dashboard (running on its own dev server port) to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# GET /providers/status — which providers have an API key configured in .env.
# Real read of os.environ, not a hardcoded list — used by the Settings page.
@app.get("/providers/status")
def providers_status():
    return {
        "gemini": bool(os.environ.get("GEMINI_API_KEY")),
        "groq": bool(os.environ.get("GROQ_API_KEY")),
        "openrouter": bool(os.environ.get("OPENROUTER_API_KEY")),
    }


# GET /models/catalog — which model strings each provider is allowed to run.
# Single source of truth lives in providers.py; both Playground's model
# picker and the Models page read from this instead of the frontend
# duplicating the model strings.
@app.get("/models/catalog")
def models_catalog():
    return MODEL_CATALOG


# 6. POST /traces — creates a new trace row and returns it.
@app.post("/traces", response_model=TraceResponse)
def create_trace(trace: TraceCreate, db: Session = Depends(get_db)):
    # Build a SQLAlchemy model instance from the incoming JSON.
    # exclude_unset=True means fields the client didn't send (like started_at)
    # are left out, so the database's own defaults (e.g. now()) apply instead.
    db_trace = Trace(**trace.model_dump(exclude_unset=True))

    db.add(db_trace)        # stage the new row
    db.commit()             # save it to the database
    db.refresh(db_trace)    # reload it, picking up DB-generated values (id, started_at)

    db_trace.status = "success" if db_trace.ended_at is not None else "pending"
    return db_trace


# 7. GET /traces — lists every trace, most recent first.
# `status` isn't a DB column — it's derived here from whether any child span
# recorded an error, using the spans.error column added earlier.
@app.get("/traces", response_model=list[TraceResponse])
def list_traces(db: Session = Depends(get_db)):
    traces = db.query(Trace).order_by(Trace.started_at.desc()).all()

    error_trace_ids = {
        row[0] for row in db.query(Span.trace_id).filter(Span.error.isnot(None)).distinct().all()
    }
    for trace in traces:
        if trace.id in error_trace_ids:
            trace.status = "error"
        elif trace.ended_at is None:
            trace.status = "pending"
        else:
            trace.status = "success"

    return traces


# 8. GET /traces/{trace_id} — fetches one trace along with all of its spans.
@app.get("/traces/{trace_id}", response_model=TraceWithSpans)
def get_trace(trace_id: uuid.UUID, db: Session = Depends(get_db)):
    db_trace = db.get(Trace, trace_id)

    if db_trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")

    if any(span.error for span in db_trace.spans):
        db_trace.status = "error"
    elif db_trace.ended_at is None:
        db_trace.status = "pending"
    else:
        db_trace.status = "success"

    return db_trace


# PATCH /traces/{trace_id}/flag — manual human-review workflow: flag a trace
# for a second look (optionally with a note), or clear the flag once resolved.
# Backs the Review queue page; nothing here is scored/graded automatically.
@app.patch("/traces/{trace_id}/flag", response_model=TraceResponse)
def flag_trace(trace_id: uuid.UUID, update: TraceFlagUpdate, db: Session = Depends(get_db)):
    db_trace = db.get(Trace, trace_id)
    if db_trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")

    db_trace.flagged_for_review = update.flagged_for_review
    db_trace.review_note = update.review_note
    db.commit()
    db.refresh(db_trace)

    db_trace.status = (
        "error" if any(span.error for span in db_trace.spans) else ("pending" if db_trace.ended_at is None else "success")
    )
    return db_trace


# Helper for POST /spans below: turns a raw error message into a short,
# jargon-free explanation using Groq (reusing the same free-tier wrapper
# from providers.py that Playground/Evaluation call). If the explanation
# call itself fails, we return a fallback string instead of raising —
# a broken "explain the error" feature shouldn't break error logging.
def _explain_error(step_name: str, input: Optional[str], error: str) -> str:
    call_groq = PROVIDERS["groq"]
    prompt = (
        "You are helping a beginner developer understand an error in their AI pipeline. "
        f"Here is the step that failed: {step_name}. "
        f"Here is the input: {input}. "
        f"Here is the raw error: {error}. "
        "Explain in 2-3 simple sentences what likely went wrong and suggest one possible fix. "
        "Avoid jargon."
    )
    try:
        explanation, _input_tokens, _output_tokens = call_groq(prompt)
        return explanation
    except Exception as e:
        return f"(Couldn't generate an explanation: {e})"


# 9. POST /spans — creates a new span row (one step within a trace) and returns it.
# If the caller included an `error`, we also generate a plain-language
# explanation and store it in `error_explanation` before returning.
@app.post("/spans", response_model=SpanResponse)
def create_span(span: SpanCreate, db: Session = Depends(get_db)):
    if span.parent_span_id is not None:
        parent = db.get(Span, span.parent_span_id)
        if parent is None or parent.trace_id != span.trace_id:
            raise HTTPException(status_code=400, detail="parent_span_id must reference a span in the same trace")

    db_span = Span(**span.model_dump(exclude_unset=True))

    db.add(db_span)
    db.commit()
    db.refresh(db_span)

    if db_span.error:
        db_span.error_explanation = _explain_error(db_span.step_name, db_span.input, db_span.error)
        db.commit()
        db.refresh(db_span)

    return db_span


# POST /scores — creates a new score row (an LLM-judged rating for a trace,
# e.g. "relevance": 0.9) and returns it. score_trace.py calls this after it
# gets a score + explanation back from the judge LLM.
@app.post("/scores", response_model=ScoreResponse)
def create_score(score: ScoreCreate, db: Session = Depends(get_db)):
    db_score = Score(**score.model_dump(exclude_unset=True))

    db.add(db_score)
    db.commit()
    db.refresh(db_score)

    return db_score


# Datasets — named, reusable sets of eval test cases (see the Dataset model
# and DatasetCreate/DatasetListItem/DatasetResponse schemas above).
@app.get("/datasets", response_model=list[DatasetListItem])
def list_datasets(db: Session = Depends(get_db)):
    datasets = db.query(Dataset).order_by(Dataset.updated_at.desc()).all()
    return [
        DatasetListItem(
            id=d.id,
            name=d.name,
            description=d.description,
            case_count=len(d.cases or []),
            created_at=d.created_at,
            updated_at=d.updated_at,
        )
        for d in datasets
    ]


@app.post("/datasets", response_model=DatasetResponse)
def create_dataset(dataset: DatasetCreate, db: Session = Depends(get_db)):
    db_dataset = Dataset(
        name=dataset.name,
        description=dataset.description,
        cases=[c.model_dump() for c in dataset.cases],
    )
    db.add(db_dataset)
    db.commit()
    db.refresh(db_dataset)
    return db_dataset


@app.get("/datasets/{dataset_id}", response_model=DatasetResponse)
def get_dataset(dataset_id: uuid.UUID, db: Session = Depends(get_db)):
    db_dataset = db.get(Dataset, dataset_id)
    if db_dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return db_dataset


@app.put("/datasets/{dataset_id}", response_model=DatasetResponse)
def update_dataset(dataset_id: uuid.UUID, dataset: DatasetCreate, db: Session = Depends(get_db)):
    db_dataset = db.get(Dataset, dataset_id)
    if db_dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    db_dataset.name = dataset.name
    db_dataset.description = dataset.description
    db_dataset.cases = [c.model_dump() for c in dataset.cases]
    db.commit()
    db.refresh(db_dataset)
    return db_dataset


@app.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: uuid.UUID, db: Session = Depends(get_db)):
    db_dataset = db.get(Dataset, dataset_id)
    if db_dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    db.delete(db_dataset)
    db.commit()
    return {"ok": True}


# Prompts — saved, reusable system-prompt templates for the Playground page
# (see the Prompt model and PromptCreate/PromptResponse schemas above).
@app.get("/prompts", response_model=list[PromptResponse])
def list_prompts(db: Session = Depends(get_db)):
    return db.query(Prompt).order_by(Prompt.updated_at.desc()).all()


@app.post("/prompts", response_model=PromptResponse)
def create_prompt(prompt: PromptCreate, db: Session = Depends(get_db)):
    db_prompt = Prompt(**prompt.model_dump())
    db.add(db_prompt)
    db.commit()
    db.refresh(db_prompt)

    db.add(PromptVersion(
        prompt_id=db_prompt.id,
        name=db_prompt.name,
        category=db_prompt.category,
        content=db_prompt.content,
        tags=db_prompt.tags,
    ))
    db.commit()

    return db_prompt


@app.get("/prompts/{prompt_id}", response_model=PromptResponse)
def get_prompt(prompt_id: uuid.UUID, db: Session = Depends(get_db)):
    db_prompt = db.get(Prompt, prompt_id)
    if db_prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return db_prompt


@app.put("/prompts/{prompt_id}", response_model=PromptResponse)
def update_prompt(prompt_id: uuid.UUID, prompt: PromptCreate, db: Session = Depends(get_db)):
    db_prompt = db.get(Prompt, prompt_id)
    if db_prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")

    db_prompt.name = prompt.name
    db_prompt.category = prompt.category
    db_prompt.content = prompt.content
    db_prompt.tags = prompt.tags
    db.commit()
    db.refresh(db_prompt)

    # Snapshot every save as a new version — a save is never a silent
    # overwrite, it's always got a recoverable history behind it.
    db.add(PromptVersion(
        prompt_id=db_prompt.id,
        name=db_prompt.name,
        category=db_prompt.category,
        content=db_prompt.content,
        tags=db_prompt.tags,
    ))
    db.commit()

    return db_prompt


# GET /prompts/{id}/versions — full save history for a prompt, most recent
# first, so Prompt Library can show what changed and let you restore an
# earlier version into the editable draft (restoring doesn't auto-save —
# it's still a normal edit the user has to Save, same as any other change).
@app.get("/prompts/{prompt_id}/versions", response_model=list[PromptVersionResponse])
def list_prompt_versions(prompt_id: uuid.UUID, db: Session = Depends(get_db)):
    if db.get(Prompt, prompt_id) is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return (
        db.query(PromptVersion)
        .filter(PromptVersion.prompt_id == prompt_id)
        .order_by(PromptVersion.created_at.desc())
        .all()
    )


@app.delete("/prompts/{prompt_id}")
def delete_prompt(prompt_id: uuid.UUID, db: Session = Depends(get_db)):
    db_prompt = db.get(Prompt, prompt_id)
    if db_prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")

    db.delete(db_prompt)
    db.commit()
    return {"ok": True}


# POST /prompts/{id}/use — bumps usage_count whenever a saved prompt is
# loaded into Playground. An atomic UPDATE (not read-modify-write) — same
# cost either way, removes a lost-update mode from a fast double-click.
@app.post("/prompts/{prompt_id}/use", response_model=PromptResponse)
def use_prompt(prompt_id: uuid.UUID, db: Session = Depends(get_db)):
    db_prompt = db.get(Prompt, prompt_id)
    if db_prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")

    db.query(Prompt).filter(Prompt.id == prompt_id).update({Prompt.usage_count: Prompt.usage_count + 1})
    db.commit()
    db.refresh(db_prompt)
    return db_prompt


# 10. Shared helper: build + save a Trace row, used by the Playground and
# Evaluation endpoints below so a run always shows up in Overview/Traces.
def _log_trace(db: Session, *, name: str, input: str, output: str, started_at, ended_at, total_tokens: int, cost: float, model: Optional[str] = None) -> Trace:
    db_trace = Trace(
        name=name,
        input=input,
        output=output,
        started_at=started_at,
        ended_at=ended_at,
        total_tokens=total_tokens,
        cost=cost,
        model=model,
    )
    db.add(db_trace)
    db.commit()
    db.refresh(db_trace)
    db_trace.status = "success"  # freshly logged synchronous runs always complete cleanly
    return db_trace


# Shared helper: build + save a Span row under a trace, optionally nested
# under a parent span. Used by Playground/Evaluation so every real LLM call
# (and, for eval cases, the scorer/judge call that follows it) shows up as a
# real span in TraceDetails' Timeline instead of that tab always being empty.
def _log_span(db: Session, *, trace_id, step_name: str, input: str, output: str, started_at, ended_at, error: Optional[str] = None, parent_span_id=None) -> Span:
    db_span = Span(
        trace_id=trace_id,
        parent_span_id=parent_span_id,
        step_name=step_name,
        input=input,
        output=output,
        started_at=started_at,
        ended_at=ended_at,
        error=error,
    )
    db.add(db_span)
    db.commit()
    db.refresh(db_span)
    if error:
        db_span.error_explanation = _explain_error(step_name, input, error)
        db.commit()
        db.refresh(db_span)
    return db_span


# 11. Playground — send a prompt (with full conversation history, an optional
# system prompt, and sampling params) to a free-tier provider, logging each
# turn as its own trace.
class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class PlaygroundRequest(BaseModel):
    provider: ProviderName
    messages: list[ChatMessage]  # the running conversation; the last item is the new user turn
    system_prompt: Optional[str] = None
    model: Optional[str] = None  # must be one of MODEL_CATALOG[provider]["models"]; falls back to that provider's default
    temperature: Optional[float] = None
    top_p: Optional[float] = None


class PlaygroundResponse(BaseModel):
    answer: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost: float
    latency_ms: int
    trace: TraceResponse


@app.post("/playground/run", response_model=PlaygroundResponse)
def run_playground(req: PlaygroundRequest, db: Session = Depends(get_db)):
    call_provider = PROVIDERS[req.provider]

    # Never pass an arbitrary client-supplied string straight into a real
    # provider call — validate it against this provider's catalog first,
    # falling back to that provider's default model if none was given.
    catalog = MODEL_CATALOG[req.provider]
    if req.model and req.model in catalog["models"]:
        model_used = req.model
    else:
        model_used = catalog["default"]

    provider_messages = [m.model_dump() for m in req.messages]
    if req.system_prompt:
        provider_messages = [{"role": "system", "content": req.system_prompt}] + provider_messages
    last_user_message = req.messages[-1].content if req.messages else ""

    started_at = datetime.now(timezone.utc)
    try:
        answer, input_tokens, output_tokens = call_provider(
            provider_messages, model=model_used, temperature=req.temperature, top_p=req.top_p
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{req.provider} call failed: {e}")
    ended_at = datetime.now(timezone.utc)

    total_tokens = input_tokens + output_tokens
    cost = estimate_cost(model_used, input_tokens, output_tokens)

    db_trace = _log_trace(
        db,
        name=f"playground: {req.provider}",
        input=last_user_message,
        output=answer,
        started_at=started_at,
        ended_at=ended_at,
        total_tokens=total_tokens,
        cost=cost,
        model=model_used,
    )
    _log_span(
        db,
        trace_id=db_trace.id,
        step_name="llm_call",
        input=last_user_message,
        output=answer,
        started_at=started_at,
        ended_at=ended_at,
    )

    return PlaygroundResponse(
        answer=answer,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cost=cost,
        latency_ms=int((ended_at - started_at).total_seconds() * 1000),
        trace=db_trace,
    )


# 12. Evaluation — run a small set of test cases across one or more providers,
# grading each answer with a simple case-insensitive substring match.
# (EvalCase is defined earlier, alongside the Dataset schemas that reuse it.)
class EvalRequest(BaseModel):
    providers: list[ProviderName]
    cases: list[EvalCase]
    scorer_slugs: list[str] = []


class EvalCaseResult(BaseModel):
    question: str
    expected: Optional[str]
    provider: str
    answer: str
    passed: Optional[bool]
    # LLM-judge scores (see _judge_answer below) — None if judging failed.
    faithfulness: Optional[float] = None
    relevance: Optional[float] = None
    hallucination: Optional[bool] = None
    judge_notes: Optional[str] = None
    # Custom Scorer results selected for this run: {scorer_name: 0.0-1.0}.
    scorer_scores: dict[str, float] = {}
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost: float
    latency_ms: int
    trace_id: Optional[uuid.UUID]


class EvalResponse(BaseModel):
    results: list[EvalCaseResult]


# Uses Groq as a fixed "judge" model (regardless of which provider produced
# the answer — the standard LLM-as-judge pattern) to score an eval answer.
# Falls back to all-None scores if the call or JSON parsing fails, so a
# broken judge never breaks the eval run itself.
def _judge_answer(question: str, expected: Optional[str], answer: str) -> dict:
    call_groq = PROVIDERS["groq"]
    prompt = (
        "You are grading an AI assistant's answer for quality. "
        f"Question: {question} "
        f"Expected answer / key facts (may be empty if not provided): {expected or '(none provided)'} "
        f"The assistant's answer: {answer} "
        "Score the answer and respond with ONLY a JSON object, no other text, in this exact shape: "
        '{"faithfulness": <0.0-1.0>, "relevance": <0.0-1.0>, "hallucination": <true/false>, "notes": "<one short sentence>"} '
        "faithfulness = does the answer avoid contradicting the expected facts (if given)? "
        "relevance = does the answer actually address the question asked? "
        "hallucination = true if the answer states specific facts/numbers/claims that are not "
        "supported by the expected answer or common knowledge."
    )
    try:
        raw, _input_tokens, _output_tokens = call_groq(prompt)
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(cleaned)
        return {
            "faithfulness": float(parsed["faithfulness"]),
            "relevance": float(parsed["relevance"]),
            "hallucination": bool(parsed["hallucination"]),
            "judge_notes": parsed.get("notes"),
        }
    except Exception as e:
        return {"faithfulness": None, "relevance": None, "hallucination": None, "judge_notes": f"(judge failed: {e})"}


# Runs one user-defined Scorer against one (question, answer, expected)
# triple. Substitutes {{input}}/{{output}}/{{expected}} into the scorer's own
# prompt template, asks Groq (same fixed-judge convention as _judge_answer)
# to respond with ONLY the chosen label, then maps that label to a 0-1 score
# via the scorer's choice_scores. An unrecognized/unparseable label returns
# score=None rather than guessing.
_SCORER_PLACEHOLDERS = re.compile(r"\{\{(input|output|expected)\}\}")


def _run_custom_scorer(scorer: "Scorer", question: str, answer: str, expected: Optional[str]) -> dict:
    call_groq = PROVIDERS["groq"]
    values = {"input": question, "output": answer, "expected": expected or "(none provided)"}
    # A single regex pass over the ORIGINAL template — substituting only the
    # placeholders that were actually written there — so if `question` or
    # `answer` itself contains literal text like "{{output}}" (e.g. a
    # question about templating syntax), that text is never re-substituted
    # by a later step the way chained str.replace() calls would.
    filled = _SCORER_PLACEHOLDERS.sub(lambda m: values[m.group(1)], scorer.prompt_template)
    choices = list(scorer.choice_scores.keys())
    prompt = (
        f"{filled}\n\n"
        f"Respond with ONLY one of these exact labels, nothing else: {', '.join(choices)}"
    )
    try:
        raw, _input_tokens, _output_tokens = call_groq(prompt)
        label = raw.strip().strip('"').strip(".")
        # Exact match first, then a tolerant substring match (judges sometimes
        # wrap the label in a short sentence despite the instruction above).
        if label not in scorer.choice_scores:
            label = next((c for c in choices if c.lower() in raw.lower()), None)
        if label is None:
            return {"label": None, "score": None, "explanation": f"(unrecognized judge response: {raw[:120]})"}
        return {"label": label, "score": float(scorer.choice_scores[label]), "explanation": raw.strip()}
    except Exception as e:
        return {"label": None, "score": None, "explanation": f"(scorer failed: {e})"}


# Wraps a blocking call with its own wall-clock start/end, so a batch of
# these can run concurrently in a thread pool while each result still carries
# an accurate timestamp for its own span (see _run_eval_case below).
def _timed_call(fn, *args):
    started = datetime.now(timezone.utc)
    result = fn(*args)
    ended = datetime.now(timezone.utc)
    return result, started, ended


# Runs one (case, provider) pair end-to-end: answer, keyword match, LLM-judge
# score, any selected custom Scorers, trace + nested span log. Shared by both
# the batch endpoint below and the single-pair endpoint the frontend uses for
# live per-case progress.
def _run_eval_case(case: EvalCase, provider: str, db: Session, scorers: Optional[list["Scorer"]] = None) -> EvalCaseResult:
    scorers = scorers or []
    call_provider = PROVIDERS[provider]
    # Evaluation has no model picker in the UI (it already runs multiple
    # providers per case; picking a model per provider row is a separate UI
    # decision for later) — it always calls that provider's default model.
    # Resolving and recording it here doesn't change behavior, it just makes
    # that existing fact visible on the trace instead of leaving model NULL.
    model_used = MODEL_CATALOG[provider]["default"]
    started_at = datetime.now(timezone.utc)

    try:
        answer, input_tokens, output_tokens = call_provider(case.question, model=model_used)
    except Exception as e:
        # One failing case/provider shouldn't abort the whole run.
        return EvalCaseResult(
            question=case.question,
            expected=case.expected,
            provider=provider,
            answer=f"Error: {e}",
            passed=False,
            input_tokens=0,
            output_tokens=0,
            total_tokens=0,
            cost=0.0,
            latency_ms=0,
            trace_id=None,
        )

    ended_at = datetime.now(timezone.utc)
    total_tokens = input_tokens + output_tokens
    cost = estimate_cost(model_used, input_tokens, output_tokens)

    passed = None
    if case.expected and case.expected.strip():
        passed = case.expected.strip().lower() in answer.lower()

    # The built-in judge and every selected custom Scorer are independent
    # Groq calls that don't touch the DB, so they run concurrently instead of
    # one-after-another — with N scorers selected, this keeps per-case
    # latency close to one round-trip instead of N+1.
    with ThreadPoolExecutor(max_workers=len(scorers) + 1) as pool:
        judge_future = pool.submit(_timed_call, _judge_answer, case.question, case.expected, answer)
        scorer_futures = [
            (scorer, pool.submit(_timed_call, _run_custom_scorer, scorer, case.question, answer, case.expected))
            for scorer in scorers
        ]
        judge, judge_started, judge_ended = judge_future.result()
        scorer_outcomes = [(scorer, *future.result()) for scorer, future in scorer_futures]

    db_trace = _log_trace(
        db,
        name=f"eval: {provider}",
        input=case.question,
        output=answer,
        started_at=started_at,
        ended_at=ended_at,
        total_tokens=total_tokens,
        cost=cost,
        model=model_used,
    )
    llm_span = _log_span(
        db,
        trace_id=db_trace.id,
        step_name="llm_call",
        input=case.question,
        output=answer,
        started_at=started_at,
        ended_at=ended_at,
    )

    # The built-in judge and any selected custom Scorers each get their own
    # span, nested under the LLM call they're judging — real parent/child
    # span data for TraceDetails' Timeline tree, not a flat list. Span writes
    # themselves stay sequential on this thread (a SQLAlchemy Session isn't
    # safe to share across threads) — only the network calls above ran concurrently.
    _log_span(
        db,
        trace_id=db_trace.id,
        parent_span_id=llm_span.id,
        step_name="judge:builtin",
        input=f"question={case.question!r} expected={case.expected!r} answer={answer!r}",
        output=json.dumps(judge),
        started_at=judge_started,
        ended_at=judge_ended,
    )

    scorer_scores = {}
    for scorer, result, scorer_started, scorer_ended in scorer_outcomes:
        _log_span(
            db,
            trace_id=db_trace.id,
            parent_span_id=llm_span.id,
            step_name=f"judge:{scorer.slug}",
            input=case.question,
            output=result["explanation"] or "",
            started_at=scorer_started,
            ended_at=scorer_ended,
        )
        if result["score"] is not None:
            scorer_scores[scorer.name] = result["score"]

    return EvalCaseResult(
        question=case.question,
        expected=case.expected,
        provider=provider,
        answer=answer,
        passed=passed,
        faithfulness=judge["faithfulness"],
        relevance=judge["relevance"],
        hallucination=judge["hallucination"],
        judge_notes=judge["judge_notes"],
        scorer_scores=scorer_scores,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cost=cost,
        latency_ms=int((ended_at - started_at).total_seconds() * 1000),
        trace_id=db_trace.id,
    )


# Single-pair endpoint — lets the frontend run cases one at a time and show
# live progress, instead of waiting on one big batch call.
class EvalSingleRequest(BaseModel):
    provider: ProviderName
    question: str
    expected: Optional[str] = None
    scorer_slugs: list[str] = []


def _lookup_scorers(db: Session, slugs: list[str]) -> list[Scorer]:
    if not slugs:
        return []
    return db.query(Scorer).filter(Scorer.slug.in_(slugs)).all()


@app.post("/evaluation/run_one", response_model=EvalCaseResult)
def run_evaluation_one(req: EvalSingleRequest, db: Session = Depends(get_db)):
    case = EvalCase(question=req.question, expected=req.expected)
    return _run_eval_case(case, req.provider, db, scorers=_lookup_scorers(db, req.scorer_slugs))


@app.post("/evaluation/run", response_model=EvalResponse)
def run_evaluation(req: EvalRequest, db: Session = Depends(get_db)):
    scorers = _lookup_scorers(db, req.scorer_slugs)
    results = [_run_eval_case(case, provider, db, scorers=scorers) for case in req.cases for provider in req.providers]
    return EvalResponse(results=results)


# 13. Scorers — user-defined LLM-judge rubrics, selectable in Evaluation
# alongside the built-in faithfulness/relevance judge (see ScorerCreate/
# ScorerResponse above and _run_custom_scorer above).
def _slugify(name: str) -> str:
    slug = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "scorer"


@app.get("/scorers", response_model=list[ScorerResponse])
def list_scorers(db: Session = Depends(get_db)):
    return db.query(Scorer).order_by(Scorer.updated_at.desc()).all()


@app.post("/scorers", response_model=ScorerResponse)
def create_scorer(scorer: ScorerCreate, db: Session = Depends(get_db)):
    base_slug = _slugify(scorer.name)
    slug = base_slug
    suffix = 2
    while db.query(Scorer).filter(Scorer.slug == slug).first() is not None:
        slug = f"{base_slug}-{suffix}"
        suffix += 1

    db_scorer = Scorer(slug=slug, **scorer.model_dump())
    db.add(db_scorer)
    try:
        db.commit()
    except IntegrityError:
        # Two concurrent creates picked the same "free" slug between the
        # check above and this commit — rather than a raw 500, tell the
        # client to retry (a fresh check will see the now-taken slug).
        db.rollback()
        raise HTTPException(status_code=409, detail="Slug collision, please retry")
    db.refresh(db_scorer)
    return db_scorer


@app.get("/scorers/{scorer_id}", response_model=ScorerResponse)
def get_scorer(scorer_id: uuid.UUID, db: Session = Depends(get_db)):
    db_scorer = db.get(Scorer, scorer_id)
    if db_scorer is None:
        raise HTTPException(status_code=404, detail="Scorer not found")
    return db_scorer


@app.put("/scorers/{scorer_id}", response_model=ScorerResponse)
def update_scorer(scorer_id: uuid.UUID, scorer: ScorerCreate, db: Session = Depends(get_db)):
    db_scorer = db.get(Scorer, scorer_id)
    if db_scorer is None:
        raise HTTPException(status_code=404, detail="Scorer not found")

    db_scorer.name = scorer.name
    db_scorer.description = scorer.description
    db_scorer.prompt_template = scorer.prompt_template
    db_scorer.choice_scores = scorer.choice_scores
    db_scorer.pass_threshold = scorer.pass_threshold
    db.commit()
    db.refresh(db_scorer)
    return db_scorer


@app.delete("/scorers/{scorer_id}")
def delete_scorer(scorer_id: uuid.UUID, db: Session = Depends(get_db)):
    db_scorer = db.get(Scorer, scorer_id)
    if db_scorer is None:
        raise HTTPException(status_code=404, detail="Scorer not found")

    db.delete(db_scorer)
    db.commit()
    return {"ok": True}


# 14. Experiments — a persisted snapshot of an Evaluation run (see Experiment/
# ExperimentResult models and schemas above). Evaluation itself never writes
# these directly; the frontend calls POST /experiments with the run's results
# (already sitting in browser state right after a run finishes) once the user
# clicks "Save as Experiment."
def _experiment_pass_rate(results: list[ExperimentResult]) -> Optional[float]:
    graded = [r for r in results if r.passed is not None]
    if not graded:
        return None
    return sum(1 for r in graded if r.passed) / len(graded)


@app.get("/experiments", response_model=list[ExperimentListItem])
def list_experiments(db: Session = Depends(get_db)):
    experiments = db.query(Experiment).order_by(Experiment.created_at.desc()).all()
    return [
        ExperimentListItem(
            id=e.id,
            name=e.name,
            description=e.description,
            dataset_id=e.dataset_id,
            providers=e.providers or [],
            scorer_slugs=e.scorer_slugs or [],
            created_at=e.created_at,
            result_count=len(e.results),
            pass_rate=_experiment_pass_rate(e.results),
        )
        for e in experiments
    ]


@app.post("/experiments", response_model=ExperimentResponse)
def create_experiment(experiment: ExperimentCreate, db: Session = Depends(get_db)):
    db_experiment = Experiment(
        name=experiment.name,
        description=experiment.description,
        dataset_id=experiment.dataset_id,
        providers=experiment.providers,
        scorer_slugs=experiment.scorer_slugs,
    )
    db.add(db_experiment)
    db.commit()
    db.refresh(db_experiment)

    for r in experiment.results:
        db.add(ExperimentResult(experiment_id=db_experiment.id, **r.model_dump()))
    db.commit()
    db.refresh(db_experiment)

    return db_experiment


@app.get("/experiments/{experiment_id}", response_model=ExperimentResponse)
def get_experiment(experiment_id: uuid.UUID, db: Session = Depends(get_db)):
    db_experiment = db.get(Experiment, experiment_id)
    if db_experiment is None:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return db_experiment


@app.delete("/experiments/{experiment_id}")
def delete_experiment(experiment_id: uuid.UUID, db: Session = Depends(get_db)):
    db_experiment = db.get(Experiment, experiment_id)
    if db_experiment is None:
        raise HTTPException(status_code=404, detail="Experiment not found")

    db.delete(db_experiment)
    db.commit()
    return {"ok": True}


# 15. Alert rules — threshold checks against real trace data within a
# trailing window (see AlertRule model/schemas above). There's no email/Slack
# integration in this app, so "triggered" surfaces only in the Alerts page —
# it's a real, computed signal, just not a pushed notification.
@app.get("/alert-rules", response_model=list[AlertRuleResponse])
def list_alert_rules(db: Session = Depends(get_db)):
    return db.query(AlertRule).order_by(AlertRule.created_at.desc()).all()


@app.post("/alert-rules", response_model=AlertRuleResponse)
def create_alert_rule(rule: AlertRuleCreate, db: Session = Depends(get_db)):
    db_rule = AlertRule(**rule.model_dump())
    db.add(db_rule)
    db.commit()
    db.refresh(db_rule)
    return db_rule


@app.put("/alert-rules/{rule_id}", response_model=AlertRuleResponse)
def update_alert_rule(rule_id: uuid.UUID, rule: AlertRuleCreate, db: Session = Depends(get_db)):
    db_rule = db.get(AlertRule, rule_id)
    if db_rule is None:
        raise HTTPException(status_code=404, detail="Alert rule not found")

    for field, value in rule.model_dump().items():
        setattr(db_rule, field, value)
    db.commit()
    db.refresh(db_rule)
    return db_rule


@app.delete("/alert-rules/{rule_id}")
def delete_alert_rule(rule_id: uuid.UUID, db: Session = Depends(get_db)):
    db_rule = db.get(AlertRule, rule_id)
    if db_rule is None:
        raise HTTPException(status_code=404, detail="Alert rule not found")

    db.delete(db_rule)
    db.commit()
    return {"ok": True}


def _evaluate_alert_rule(rule: AlertRule, db: Session) -> AlertStatus:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=rule.window_minutes)
    traces = db.query(Trace).filter(Trace.started_at >= cutoff).all()

    current_value = None
    if rule.metric == "error_rate":
        if traces:
            error_trace_ids = {
                row[0]
                for row in db.query(Span.trace_id)
                .filter(Span.trace_id.in_([t.id for t in traces]), Span.error.isnot(None))
                .distinct()
                .all()
            }
            current_value = 100.0 * len(error_trace_ids) / len(traces)
    elif rule.metric == "p95_latency_ms":
        durations = sorted(
            (t.ended_at - t.started_at).total_seconds() * 1000 for t in traces if t.ended_at is not None
        )
        if durations:
            idx = min(len(durations) - 1, int(round(0.95 * (len(durations) - 1))))
            current_value = durations[idx]
    elif rule.metric == "avg_cost_per_request":
        if traces:
            current_value = sum(float(t.cost or 0) for t in traces) / len(traces)

    threshold = float(rule.threshold)
    triggered = current_value is not None and (
        current_value > threshold if rule.comparator == ">" else current_value < threshold
    )

    return AlertStatus(
        rule=rule,
        current_value=current_value,
        triggered=bool(triggered),
        sample_size=len(traces),
    )


# GET /alerts/status — every enabled rule's live-computed value against real
# trace data right now. Recomputed on every call, nothing cached/scheduled —
# there's no background job runner in this app (see main.py's docstring).
@app.get("/alerts/status", response_model=list[AlertStatus])
def alerts_status(db: Session = Depends(get_db)):
    rules = db.query(AlertRule).filter(AlertRule.enabled.is_(True)).all()
    return [_evaluate_alert_rule(rule, db) for rule in rules]


# 16. AI analysis — a real LLM call (Groq, fast + free-tier) that reads an
# experiment's actual results and explains what's failing and why, the same
# "point an LLM at your own eval data" pattern Braintrust's Loop uses. This is
# single-shot analysis of real data already computed by the run — it does not
# invent scores or fabricate findings not present in the results it's given.
class AnalyzeExperimentRequest(BaseModel):
    focus: Optional[str] = None  # optional free-text steer, e.g. "why did BrandAlignment drop?"


class AnalyzeExperimentResponse(BaseModel):
    analysis: str


@app.post("/experiments/{experiment_id}/analyze", response_model=AnalyzeExperimentResponse)
def analyze_experiment(experiment_id: uuid.UUID, req: AnalyzeExperimentRequest, db: Session = Depends(get_db)):
    db_experiment = db.get(Experiment, experiment_id)
    if db_experiment is None:
        raise HTTPException(status_code=404, detail="Experiment not found")

    results = db_experiment.results
    if not results:
        return AnalyzeExperimentResponse(analysis="This experiment has no results yet — nothing to analyze.")

    def score_of(r):
        graded = [v for v in (r.scores or {}).values()]
        if r.passed is not None:
            graded.append(1.0 if r.passed else 0.0)
        return sum(graded) / len(graded) if graded else None

    scored = [(r, score_of(r)) for r in results]
    ranked = sorted([sr for sr in scored if sr[1] is not None], key=lambda sr: sr[1])
    worst = ranked[:5]
    best = ranked[-3:] if len(ranked) > 3 else []

    def describe(r, score):
        return f"- provider={r.provider} score={score:.2f} question={r.question!r} answer={r.answer[:200]!r}"

    prompt = (
        f"You are analyzing the results of an LLM evaluation experiment named {db_experiment.name!r}. "
        f"It has {len(results)} total results across providers {db_experiment.providers}. "
        + (f"The user wants you to focus on: {req.focus}. " if req.focus else "")
        + "Here are the worst-scoring cases:\n"
        + "\n".join(describe(r, s) for r, s in worst)
        + ("\n\nHere are some of the best-scoring cases for contrast:\n" + "\n".join(describe(r, s) for r, s in best) if best else "")
        + "\n\nIn 4-6 short sentences: explain the likely root cause(s) of the low-scoring cases, "
        "point out any pattern across them, and recommend one concrete, actionable fix "
        "(to the prompt, the scorer's rubric, or the provider/model choice). "
        "Be specific and reference the actual cases above — do not invent cases not shown here."
    )

    call_groq = PROVIDERS["groq"]
    try:
        analysis, _input_tokens, _output_tokens = call_groq(prompt)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Analysis failed: {e}")

    return AnalyzeExperimentResponse(analysis=analysis)
