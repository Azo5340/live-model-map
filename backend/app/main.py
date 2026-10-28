import os
import secrets
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .compare import compare
from .schemas import AIModel, Comparison, Graph, IngestResult, REAEvent, StatusReport, StreamEvent
from .store import ModelStore
from .stream import StreamManager

DATA_FILE = Path(os.getenv("DATA_FILE", Path(__file__).parent.parent / "data" / "models.json"))
INGEST_TOKEN = os.getenv("INGEST_TOKEN")  # optional shared secret for the REA scraper
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")

app = FastAPI(title="Live Model Map API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = ModelStore(DATA_FILE)
stream = StreamManager()


@app.get("/api/health")
def health():
    return {"ok": True, "models": len(store.graph().nodes), "ws_clients": stream.client_count}


@app.get("/api/models", response_model=Graph)
def list_models():
    return store.graph()


# Model ids look like "provider/name", so both segments must accept slashes.
@app.get("/api/models/{model_id:path}/compare/{target_id:path}", response_model=Comparison)
def compare_models(model_id: str, target_id: str):
    model = store.get(model_id)
    target = store.get(target_id)
    if model is None or target is None:
        missing = model_id if model is None else target_id
        raise HTTPException(404, f"unknown model: {missing}")
    return compare(model, target)


@app.get("/api/events", response_model=list[StreamEvent])
def recent_events(limit: int = 50):
    return store.recent_events(limit)


async def emit(event: StreamEvent) -> None:
    store.record_event(event)
    await stream.broadcast(event)


@app.post("/api/ingest/rea-event", response_model=IngestResult)
async def ingest_rea_event(event: REAEvent, x_ingest_token: str | None = Header(None)):
    if INGEST_TOKEN and not secrets.compare_digest(x_ingest_token or "", INGEST_TOKEN):
        raise HTTPException(401, "invalid ingest token")

    result = IngestResult(added=[], updated=[], unchanged=[], alerts=len(event.alerts))
    for model in event.models:
        outcome, previous_status = store.upsert(model)
        getattr(result, outcome).append(model.id)
        if outcome == "unchanged":
            continue
        stored = store.get(model.id)
        status_changed = outcome == "updated" and stored.status != previous_status
        await emit(StreamEvent(
            type="MODEL_ADDED" if outcome == "added"
            else "STATUS_CHANGED" if status_changed
            else "METRICS_UPDATED",
            ts=event.detected_at,
            payload={
                "source": event.source,
                "model": stored.model_dump(mode="json"),
                "previous_status": previous_status,
            },
        ))

    for alert in event.alerts:
        await emit(StreamEvent(
            type="ALERT",
            ts=event.detected_at,
            payload={"source": event.source, **alert.model_dump(mode="json")},
        ))

    return result


@app.post("/api/models/{model_id:path}/status", response_model=AIModel)
async def report_status(model_id: str, report: StatusReport, x_ingest_token: str | None = Header(None)):
    """Set a model's status by hand. The only way to set or clear a security incident."""
    if INGEST_TOKEN and not secrets.compare_digest(x_ingest_token or "", INGEST_TOKEN):
        raise HTTPException(401, "invalid ingest token")
    previous = store.get(model_id)
    if previous is None:
        raise HTTPException(404, f"unknown model: {model_id}")
    model = store.set_status(model_id, report.status, report.detail)
    await emit(StreamEvent(
        type="STATUS_CHANGED",
        payload={
            "source": report.source,
            "model": model.model_dump(mode="json"),
            "previous_status": previous.status,
        },
    ))
    return model


@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    await stream.connect(ws)
    try:
        while True:
            # Clients don't need to send anything; this just keeps the socket open
            # and lets us notice disconnects (frontend sends "ping" periodically).
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await stream.disconnect(ws)
