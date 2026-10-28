"""In-memory model registry persisted to a JSON file."""

import json
import threading
from collections import deque
from pathlib import Path

from .schemas import AIModel, Graph, GraphLink, ModelStatus, StreamEvent, utcnow


class ModelStore:
    def __init__(self, path: Path, max_events: int = 200):
        self.path = path
        self._models: dict[str, AIModel] = {}
        self._events: deque[StreamEvent] = deque(maxlen=max_events)
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        raw = json.loads(self.path.read_text())
        for item in raw.get("models", []):
            model = AIModel.model_validate(item)
            self._models[model.id] = model

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {"models": [m.model_dump(mode="json") for m in self._models.values()]}
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(self.path)

    def get(self, model_id: str) -> AIModel | None:
        return self._models.get(model_id)

    def graph(self) -> Graph:
        nodes = list(self._models.values())
        links = [
            GraphLink(source=m.parent_model_id, target=m.id)
            for m in nodes
            if m.parent_model_id and m.parent_model_id in self._models
        ]
        return Graph(nodes=nodes, links=links)

    def upsert(self, model: AIModel) -> tuple[str, ModelStatus | None]:
        """Insert or update a model.

        Returns ('added' | 'updated' | 'unchanged', previous status).
        A security incident is sticky: collectors can't clear it, only set_status can.
        """
        with self._lock:
            existing = self._models.get(model.id)
            if existing is None:
                if model.status is None:
                    model = model.model_copy(update={"status": ModelStatus.unknown})
                self._models[model.id] = model
                self._save()
                return "added", None

            previous = existing.status
            keep_existing = model.status is None or (
                previous == ModelStatus.security_incident
                and model.status != ModelStatus.security_incident
            )
            if keep_existing:
                model = model.model_copy(
                    update={"status": previous, "status_detail": existing.status_detail}
                )
            same = existing.model_dump(exclude={"updated_at"}) == model.model_dump(
                exclude={"updated_at"}
            )
            if same:
                return "unchanged", previous
            self._models[model.id] = model
            self._save()
            return "updated", previous

    def set_status(self, model_id: str, status: ModelStatus, detail: str | None) -> AIModel | None:
        with self._lock:
            existing = self._models.get(model_id)
            if existing is None:
                return None
            model = existing.model_copy(
                update={"status": status, "status_detail": detail, "updated_at": utcnow()}
            )
            self._models[model_id] = model
            self._save()
            return model

    def record_event(self, event: StreamEvent) -> None:
        self._events.append(event)

    def recent_events(self, limit: int = 50) -> list[StreamEvent]:
        return list(self._events)[-limit:][::-1]
