from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


@dataclass
class AppError(Exception):
    status_code: int
    code: str
    message: str
    hint: str = ""
    retryable: bool = False
    extra: dict[str, Any] | None = None

    def to_payload(self, request_id: str = "") -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
            "retryable": self.retryable,
            "request_id": request_id,
        }
        if self.extra:
            payload["extra"] = self.extra
        return payload


def raise_app_error(
    *,
    status_code: int,
    code: str,
    message: str,
    hint: str = "",
    retryable: bool = False,
    extra: dict[str, Any] | None = None,
) -> None:
    raise AppError(
        status_code=status_code,
        code=code,
        message=message,
        hint=hint,
        retryable=retryable,
        extra=extra,
    )


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "") or "")


def _http_detail(detail: Any) -> str:
    if isinstance(detail, str):
        return detail
    if detail is None:
        return ""
    return str(detail)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError):  # type: ignore[unused-ignore]
        return JSONResponse(status_code=exc.status_code, content=exc.to_payload(_request_id(request)))

    @app.exception_handler(HTTPException)
    async def http_error_handler(request: Request, exc: HTTPException):  # type: ignore[unused-ignore]
        # 保持兼容：如果已有标准 payload，原样透传。
        if isinstance(exc.detail, dict) and {"code", "message", "retryable"} <= set(exc.detail):
            payload = dict(exc.detail)
            payload.setdefault("request_id", _request_id(request))
            payload.setdefault("hint", "")
            return JSONResponse(status_code=exc.status_code, content=payload)
        payload = {
            "code": "HTTP_ERROR",
            "message": _http_detail(exc.detail) or "Request failed",
            "hint": "",
            "retryable": False,
            "request_id": _request_id(request),
        }
        return JSONResponse(status_code=exc.status_code, content=payload)

    @app.exception_handler(StarletteHTTPException)
    async def starlette_http_error_handler(request: Request, exc: StarletteHTTPException):  # type: ignore[unused-ignore]
        payload = {
            "code": "HTTP_ERROR",
            "message": _http_detail(exc.detail) or "Request failed",
            "hint": "",
            "retryable": False,
            "request_id": _request_id(request),
        }
        return JSONResponse(status_code=exc.status_code, content=payload)

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, _: Exception):  # type: ignore[unused-ignore]
        payload = {
            "code": "INTERNAL_ERROR",
            "message": "服务器内部错误",
            "hint": "请稍后重试，若持续失败请联系管理员并提供 request_id。",
            "retryable": True,
            "request_id": _request_id(request),
        }
        return JSONResponse(status_code=500, content=payload)
