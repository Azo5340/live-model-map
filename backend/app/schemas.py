from datetime import date, datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Metrics(BaseModel):
    tokens_per_sec: Optional[float] = Field(None, ge=0)
    latency_ms: Optional[float] = Field(None, ge=0)
    cost_per_1k_tokens: Optional[float] = Field(None, ge=0)
    context_window: Optional[int] = Field(None, ge=0)
    elo_score: Optional[float] = None


class Usage(BaseModel):
    download_count_24h: Optional[int] = Field(None, ge=0)
    active_requests_est: Optional[int] = Field(None, ge=0)


class ModelStatus(str, Enum):
    operational = "operational"
    degraded = "degraded"
    down = "down"
    security_incident = "security_incident"
    unknown = "unknown"


class AIModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(..., min_length=1, max_length=200)
    name: str
    provider: str
    parent_model_id: Optional[str] = None
    release_date: Optional[date] = None
    metrics: Metrics = Field(default_factory=Metrics)
    # The REA payload calls this block "usage_stats"; accept both spellings.
    usage: Usage = Field(
        default_factory=Usage, validation_alias=AliasChoices("usage", "usage_stats")
    )
    # None on ingest means "no opinion": the stored status is kept.
    status: Optional[ModelStatus] = None
    status_detail: Optional[str] = None
    updated_at: datetime = Field(default_factory=utcnow)

    @field_validator("release_date", mode="before")
    @classmethod
    def _date_from_timestamp(cls, v: Any) -> Any:
        # Accept full ISO timestamps ("2025-03-01T12:00:00Z") and keep the date part.
        if isinstance(v, str) and "T" in v:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).date()
        if isinstance(v, datetime):
            return v.date()
        return v


class GraphLink(BaseModel):
    source: str
    target: str


class Graph(BaseModel):
    nodes: list[AIModel]
    links: list[GraphLink]


class AlertLevel(str, Enum):
    info = "info"
    warning = "warning"
    critical = "critical"


class Alert(BaseModel):
    message: str
    level: AlertLevel = AlertLevel.info
    model_id: Optional[str] = None


class REAEvent(BaseModel):
    """Payload sent by the external REA scraper."""

    source: str = "rea"
    detected_at: datetime = Field(default_factory=utcnow)
    models: list[AIModel] = Field(default_factory=list)
    alerts: list[Alert] = Field(default_factory=list)


class StatusReport(BaseModel):
    """Manual status change, e.g. a security incident found during an REA analysis."""

    status: ModelStatus
    detail: Optional[str] = None
    source: str = "manual"


EventType = Literal["MODEL_ADDED", "METRICS_UPDATED", "STATUS_CHANGED", "ALERT"]


class StreamEvent(BaseModel):
    type: EventType
    ts: datetime = Field(default_factory=utcnow)
    payload: dict[str, Any]


class IngestResult(BaseModel):
    added: list[str]
    updated: list[str]
    unchanged: list[str]
    alerts: int


class MetricDelta(BaseModel):
    metric: str
    value: Optional[float]
    target_value: Optional[float]
    delta_pct: Optional[float]
    better: Optional[bool]
    label: str


class Comparison(BaseModel):
    model_id: str
    target_id: str
    deltas: list[MetricDelta]
