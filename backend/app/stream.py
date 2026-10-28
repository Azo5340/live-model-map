"""WebSocket connection manager that fans events out to every client."""

import asyncio
import logging

from fastapi import WebSocket

from .schemas import StreamEvent

log = logging.getLogger(__name__)


class StreamManager:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def broadcast(self, event: StreamEvent) -> None:
        message = event.model_dump_json()
        async with self._lock:
            clients = list(self._clients)
        dead = []
        for ws in clients:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        if dead:
            log.info("dropping %d dead websocket(s)", len(dead))
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)
