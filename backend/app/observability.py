from __future__ import annotations

import threading
import time
import uuid
from collections import defaultdict
from typing import Callable
import logging

from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse

_lock = threading.Lock()
_req_total: dict[tuple[str, str, int], int] = defaultdict(int)
_req_latency_ms_sum: dict[tuple[str, str], float] = defaultdict(float)
_req_latency_ms_count: dict[tuple[str, str], int] = defaultdict(int)
logger = logging.getLogger(__name__)


def _label_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _route_template(request: Request) -> str:
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str) and path:
        return path
    return request.url.path


def _record_request(method: str, route: str, status_code: int, latency_ms: float) -> None:
    with _lock:
        _req_total[(method, route, int(status_code))] += 1
        _req_latency_ms_sum[(method, route)] += float(latency_ms)
        _req_latency_ms_count[(method, route)] += 1


def _render_metrics() -> str:
    lines: list[str] = [
        "# HELP gv_http_requests_total Total HTTP requests.",
        "# TYPE gv_http_requests_total counter",
    ]
    with _lock:
        for (method, route, status), value in sorted(_req_total.items()):
            lines.append(
                f'gv_http_requests_total{{method="{_label_escape(method)}",route="{_label_escape(route)}",status="{status}"}} {value}'
            )
        lines.extend(
            [
                "# HELP gv_http_request_latency_ms_avg Average HTTP latency in milliseconds.",
                "# TYPE gv_http_request_latency_ms_avg gauge",
            ]
        )
        for (method, route), total_ms in sorted(_req_latency_ms_sum.items()):
            count = _req_latency_ms_count.get((method, route), 0)
            avg = total_ms / count if count > 0 else 0.0
            lines.append(
                f'gv_http_request_latency_ms_avg{{method="{_label_escape(method)}",route="{_label_escape(route)}"}} {avg:.3f}'
            )
    return "\n".join(lines) + "\n"


def install_observability(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_observer(request: Request, call_next: Callable):  # type: ignore[unused-ignore]
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        start = time.perf_counter()
        response: Response = await call_next(request)
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        route = _route_template(request)
        _record_request(request.method.upper(), route, response.status_code, elapsed_ms)
        logger.info(
            "http_request request_id=%s method=%s route=%s status=%s latency_ms=%.2f",
            request_id,
            request.method.upper(),
            route,
            response.status_code,
            elapsed_ms,
        )
        response.headers["X-Request-Id"] = request_id
        return response

    @app.get("/metrics")
    def metrics() -> PlainTextResponse:
        return PlainTextResponse(_render_metrics(), media_type="text/plain; version=0.0.4")
