"""
管理后台 Web 会话（JWT 仅用于 /api/auth/* 与前端持有令牌校验）。

不保护 /api/query、/api/search、/api/index-jobs 等开放接口，避免影响 Dify 与其它集成。
启用管理登录时，/api/code-chat、/api/code-chat/stream 等接口与设置页相同，需携带有效 Bearer。
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.config import settings

router = APIRouter()
_bearer = HTTPBearer(auto_error=False)

JWT_ALG = "HS256"
TOKEN_PURPOSE = "admin_ui"


class LoginBody(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MeResponse(BaseModel):
    username: str


class AuthUiStatusResponse(BaseModel):
    """ui_login_required 为 True 时，管理前端应先登录再进入控制台。"""
    ui_login_required: bool


def ui_login_enabled() -> bool:
    return bool((settings.admin_password or "").strip())


def _jwt_secret() -> str:
    s = (settings.jwt_secret or "").strip()
    if not s:
        raise HTTPException(
            status_code=503,
            detail="已设置 ADMIN_PASSWORD 但未配置 JWT_SECRET",
        )
    return s


def create_ui_token(*, username: str) -> str:
    secret = _jwt_secret()
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=max(1, settings.jwt_expire_minutes))
    payload = {
        "sub": username,
        "pur": TOKEN_PURPOSE,
        "iat": int(now.timestamp()),
        "exp": exp,
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALG)


def decode_ui_token(token: str) -> str:
    secret = _jwt_secret()
    try:
        payload = jwt.decode(token, secret, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="无效或已过期的令牌")
    if payload.get("pur") != TOKEN_PURPOSE:
        raise HTTPException(status_code=401, detail="无效的令牌类型")
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(status_code=401, detail="无效的令牌内容")
    return sub


async def require_ui_session(
    credentials: Annotated[
        Optional[HTTPAuthorizationCredentials],
        Depends(_bearer),
    ],
) -> Optional[str]:
    """未启用管理登录时不校验；启用后必须携带有效 Bearer。"""
    if not ui_login_enabled():
        return None
    if credentials is None or (credentials.scheme or "").lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="未登录",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return decode_ui_token(credentials.credentials)


@router.get("/auth/status", response_model=AuthUiStatusResponse)
def auth_ui_status():
    return AuthUiStatusResponse(ui_login_required=ui_login_enabled())


@router.post("/auth/login", response_model=TokenResponse)
def auth_ui_login(body: LoginBody):
    if not ui_login_enabled():
        raise HTTPException(
            status_code=503,
            detail="未启用管理后台登录（请设置环境变量 ADMIN_PASSWORD）",
        )
    expected_user = (settings.admin_username or "admin").strip()
    pwd = (settings.admin_password or "").strip()
    if not secrets.compare_digest(body.username.strip(), expected_user):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not secrets.compare_digest(body.password, pwd):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = create_ui_token(username=expected_user)
    return TokenResponse(access_token=token)


@router.get("/auth/me", response_model=MeResponse)
def auth_ui_me(user: Annotated[Optional[str], Depends(require_ui_session)]):
    if not ui_login_enabled():
        raise HTTPException(status_code=503, detail="未启用管理后台登录")
    if user is None:
        raise HTTPException(status_code=401, detail="未登录")
    return MeResponse(username=user)
