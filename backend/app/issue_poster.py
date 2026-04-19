from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from app.config import settings
from app.effective_settings import (
    effective_gitee_access_token,
    effective_github_access_token,
    effective_gitlab_access_token,
    field_source,
)

logger = logging.getLogger(__name__)


@dataclass
class IssuePostResult:
    posted: bool
    provider: str
    comment_id: str = ""
    comment_url: str = ""
    posted_at: str = ""
    response_excerpt: str = ""
    error: str = ""


@dataclass
class IssueLabelResult:
    updated: bool
    provider: str
    labels: list[str]
    issue_state: str = ""
    response_excerpt: str = ""
    error: str = ""


def _clean_repo_url(repo_url: str) -> str:
    text = str(repo_url or "").strip()
    return text[:-4] if text.endswith(".git") else text


def _parse_owner_repo(project_id: str, repo_url: str) -> tuple[str, str]:
    pid = str(project_id or "").strip().strip("/")
    if "/" in pid:
        owner, repo = pid.split("/", 1)
        if owner and repo:
            return owner, repo
    parsed = urlparse(_clean_repo_url(repo_url))
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2:
        return parts[-2], parts[-1]
    raise ValueError("unable to resolve owner/repo from project_id or repo_url")


def _gitlab_base_url(repo_url: str) -> str:
    cleaned = _clean_repo_url(repo_url)
    parsed = urlparse(cleaned)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    configured = str(settings.gitlab_external_url or "").strip().rstrip("/")
    if configured:
        return configured
    raise ValueError("unable to resolve gitlab base url")


def _normalize_labels(labels: list[str] | tuple[str, ...] | set[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for item in labels:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def _github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _github_labels_endpoint(project_id: str, repo_url: str, issue_number: str) -> str:
    owner, repo = _parse_owner_repo(project_id, repo_url)
    return (
        f"https://api.github.com/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/issues/"
        f"{quote(str(issue_number or '').strip(), safe='')}/labels"
    )


def _github_repo_labels_endpoint(project_id: str, repo_url: str) -> str:
    owner, repo = _parse_owner_repo(project_id, repo_url)
    return f"https://api.github.com/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/labels?per_page=100"


def _gitlab_issue_labels_endpoint(project_id: str, repo_url: str, issue_number: str) -> str:
    base_url = _gitlab_base_url(repo_url)
    encoded_project = quote(str(project_id or "").strip(), safe="")
    encoded_issue = quote(str(issue_number or "").strip(), safe="")
    return f"{base_url}/api/v4/projects/{encoded_project}/issues/{encoded_issue}"


def _gitlab_project_labels_endpoint(project_id: str, repo_url: str) -> str:
    base_url = _gitlab_base_url(repo_url)
    encoded_project = quote(str(project_id or "").strip(), safe="")
    return f"{base_url}/api/v4/projects/{encoded_project}/labels?per_page=100"


def _post_gitlab_issue_comment(project_id: str, repo_url: str, issue_number: str, reply: str) -> IssuePostResult:
    token = effective_gitlab_access_token().strip()
    logger.info(
        "issue poster provider=gitlab token_source=%s token_configured=%s project_id=%s issue_number=%s",
        field_source("gitlab_access_token"),
        bool(token),
        str(project_id or "").strip(),
        str(issue_number or "").strip(),
    )
    if not token:
        return IssuePostResult(posted=False, provider="gitlab", error="gitlab_access_token is not configured")
    base_url = _gitlab_base_url(repo_url)
    encoded_project = quote(str(project_id or "").strip(), safe="")
    endpoint = f"{base_url}/api/v4/projects/{encoded_project}/issues/{quote(str(issue_number or '').strip(), safe='')}/notes"
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(endpoint, headers={"PRIVATE-TOKEN": token}, json={"body": reply})
    if resp.is_success:
        data = resp.json() if resp.headers.get("content-type", "").lower().startswith("application/json") else {}
        return IssuePostResult(
            posted=True,
            provider="gitlab",
            comment_id=str(data.get("id") or ""),
            comment_url=str(data.get("html_url") or data.get("url") or ""),
            posted_at=str(data.get("created_at") or ""),
            response_excerpt=(resp.text or "")[:500],
        )
    return IssuePostResult(posted=False, provider="gitlab", error=f"gitlab comment post failed: {resp.status_code} {resp.text[:300]}")


def _post_github_issue_comment(project_id: str, repo_url: str, issue_number: str, reply: str) -> IssuePostResult:
    token = effective_github_access_token().strip()
    logger.info(
        "issue poster provider=github token_source=%s token_configured=%s project_id=%s issue_number=%s",
        field_source("github_access_token"),
        bool(token),
        str(project_id or "").strip(),
        str(issue_number or "").strip(),
    )
    if not token:
        return IssuePostResult(posted=False, provider="github", error="github_access_token is not configured")
    owner, repo = _parse_owner_repo(project_id, repo_url)
    endpoint = f"https://api.github.com/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/issues/{quote(str(issue_number or '').strip(), safe='')}/comments"
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(
            endpoint,
            headers=_github_headers(token),
            json={"body": reply},
        )
    if resp.is_success:
        data = resp.json() if resp.headers.get("content-type", "").lower().startswith("application/json") else {}
        return IssuePostResult(
            posted=True,
            provider="github",
            comment_id=str(data.get("id") or ""),
            comment_url=str(data.get("html_url") or data.get("url") or ""),
            posted_at=str(data.get("created_at") or ""),
            response_excerpt=(resp.text or "")[:500],
        )
    return IssuePostResult(posted=False, provider="github", error=f"github comment post failed: {resp.status_code} {resp.text[:300]}")


def _post_gitee_issue_comment(project_id: str, repo_url: str, issue_number: str, reply: str) -> IssuePostResult:
    token = effective_gitee_access_token().strip()
    logger.info(
        "issue poster provider=gitee token_source=%s token_configured=%s project_id=%s issue_number=%s",
        field_source("gitee_access_token"),
        bool(token),
        str(project_id or "").strip(),
        str(issue_number or "").strip(),
    )
    if not token:
        return IssuePostResult(posted=False, provider="gitee", error="gitee_access_token is not configured")
    owner, repo = _parse_owner_repo(project_id, repo_url)
    endpoint = f"https://gitee.com/api/v5/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/issues/{quote(str(issue_number or '').strip(), safe='')}/comments"
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(endpoint, data={"access_token": token, "body": reply})
    if resp.is_success:
        data = resp.json() if resp.headers.get("content-type", "").lower().startswith("application/json") else {}
        return IssuePostResult(
            posted=True,
            provider="gitee",
            comment_id=str(data.get("id") or ""),
            comment_url=str(data.get("html_url") or data.get("url") or ""),
            posted_at=str(data.get("created_at") or ""),
            response_excerpt=(resp.text or "")[:500],
        )
    return IssuePostResult(posted=False, provider="gitee", error=f"gitee comment post failed: {resp.status_code} {resp.text[:300]}")


def _normalize_issue_state(value: str) -> str:
    text = str(value or "").strip().lower()
    if text in {"open", "opened", "reopened", "active", "todo"}:
        return "open"
    if text in {"closed", "close", "resolved", "done", "deleted"}:
        return "closed"
    return text


def _set_github_issue_labels(project_id: str, repo_url: str, issue_number: str, labels: list[str]) -> IssueLabelResult:
    token = effective_github_access_token().strip()
    normalized_labels = _normalize_labels(labels)
    logger.info(
        "issue labels provider=github token_source=%s token_configured=%s project_id=%s issue_number=%s label_count=%s",
        field_source("github_access_token"),
        bool(token),
        str(project_id or "").strip(),
        str(issue_number or "").strip(),
        len(normalized_labels),
    )
    if not token:
        return IssueLabelResult(updated=False, provider="github", labels=normalized_labels, error="github_access_token is not configured")
    endpoint = _github_labels_endpoint(project_id, repo_url, issue_number)
    with httpx.Client(timeout=20.0) as client:
        resp = client.put(endpoint, headers=_github_headers(token), json={"labels": normalized_labels})
    if resp.is_success:
        data = resp.json() if resp.headers.get("content-type", "").lower().startswith("application/json") else []
        resolved_labels = normalized_labels
        if isinstance(data, list):
            resolved_labels = _normalize_labels(
                [str(item.get("name") or "").strip() for item in data if isinstance(item, dict) and str(item.get("name") or "").strip()]
            )
        issue_state = ""
        if isinstance(data, list) and data:
            first_item = data[0]
            if isinstance(first_item, dict):
                issue_state = _normalize_issue_state(str(first_item.get("issue", {}).get("state") or ""))
        return IssueLabelResult(
            updated=True,
            provider="github",
            labels=resolved_labels,
            issue_state=issue_state,
            response_excerpt=(resp.text or "")[:500],
        )
    return IssueLabelResult(
        updated=False,
        provider="github",
        labels=normalized_labels,
        error=f"github issue labels update failed: {resp.status_code} {resp.text[:300]}",
    )


def _set_gitlab_issue_labels(project_id: str, repo_url: str, issue_number: str, labels: list[str]) -> IssueLabelResult:
    token = effective_gitlab_access_token().strip()
    normalized_labels = _normalize_labels(labels)
    logger.info(
        "issue labels provider=gitlab token_source=%s token_configured=%s project_id=%s issue_number=%s label_count=%s",
        field_source("gitlab_access_token"),
        bool(token),
        str(project_id or "").strip(),
        str(issue_number or "").strip(),
        len(normalized_labels),
    )
    if not token:
        return IssueLabelResult(updated=False, provider="gitlab", labels=normalized_labels, error="gitlab_access_token is not configured")
    endpoint = _gitlab_issue_labels_endpoint(project_id, repo_url, issue_number)
    with httpx.Client(timeout=20.0) as client:
        resp = client.put(endpoint, headers={"PRIVATE-TOKEN": token}, json={"labels": ",".join(normalized_labels)})
    if resp.is_success:
        data = resp.json() if resp.headers.get("content-type", "").lower().startswith("application/json") else {}
        resolved_labels = normalized_labels
        if isinstance(data, dict):
            raw_labels = data.get("labels") or []
            if isinstance(raw_labels, list):
                resolved_labels = _normalize_labels([str(item or "").strip() for item in raw_labels])
        issue_state = ""
        if isinstance(data, dict):
            issue_state = _normalize_issue_state(str(data.get("state") or data.get("state_event") or ""))
        return IssueLabelResult(
            updated=True,
            provider="gitlab",
            labels=resolved_labels,
            issue_state=issue_state,
            response_excerpt=(resp.text or "")[:500],
        )
    return IssueLabelResult(
        updated=False,
        provider="gitlab",
        labels=normalized_labels,
        error=f"gitlab issue labels update failed: {resp.status_code} {resp.text[:300]}",
    )


def list_issue_label_options(*, provider: str, project_id: str, repo_url: str) -> list[str]:
    normalized_provider = str(provider or "").strip().lower()
    if normalized_provider == "github":
        token = effective_github_access_token().strip()
        if not token:
            return []
        endpoint = _github_repo_labels_endpoint(project_id, repo_url)
        with httpx.Client(timeout=20.0) as client:
            resp = client.get(endpoint, headers=_github_headers(token))
        if not resp.is_success:
            logger.warning(
                "issue label options fetch failed provider=%s project_id=%s status=%s body=%s",
                normalized_provider,
                str(project_id or "").strip(),
                resp.status_code,
                (resp.text or "")[:300],
            )
            return []
        try:
            data = resp.json()
        except json.JSONDecodeError:
            return []
        if not isinstance(data, list):
            return []
        return _normalize_labels([str(item.get("name") or "").strip() for item in data if isinstance(item, dict)])
    if normalized_provider == "gitlab":
        token = effective_gitlab_access_token().strip()
        if not token:
            return []
        endpoint = _gitlab_project_labels_endpoint(project_id, repo_url)
        with httpx.Client(timeout=20.0) as client:
            resp = client.get(endpoint, headers={"PRIVATE-TOKEN": token})
        if not resp.is_success:
            logger.warning(
                "issue label options fetch failed provider=%s project_id=%s status=%s body=%s",
                normalized_provider,
                str(project_id or "").strip(),
                resp.status_code,
                (resp.text or "")[:300],
            )
            return []
        try:
            data = resp.json()
        except json.JSONDecodeError:
            return []
        if not isinstance(data, list):
            return []
        return _normalize_labels(
            [str(item.get("name") or item.get("title") or "").strip() for item in data if isinstance(item, dict)]
        )
    return []


def set_issue_labels(*, provider: str, project_id: str, repo_url: str, issue_number: str, labels: list[str]) -> IssueLabelResult:
    normalized_provider = str(provider or "").strip().lower()
    normalized_labels = _normalize_labels(labels)
    if normalized_provider == "github":
        return _set_github_issue_labels(project_id, repo_url, issue_number, normalized_labels)
    if normalized_provider == "gitlab":
        return _set_gitlab_issue_labels(project_id, repo_url, issue_number, normalized_labels)
    return IssueLabelResult(
        updated=False,
        provider=normalized_provider or "unknown",
        labels=normalized_labels,
        error=f"unsupported provider: {normalized_provider}",
    )


def post_issue_comment(*, provider: str, project_id: str, repo_url: str, issue_number: str, reply: str) -> IssuePostResult:
    normalized_provider = str(provider or "").strip().lower()
    if not str(reply or "").strip():
        return IssuePostResult(posted=False, provider=normalized_provider or "unknown", error="reply is empty")
    if normalized_provider == "gitlab":
        return _post_gitlab_issue_comment(project_id, repo_url, issue_number, reply)
    if normalized_provider == "github":
        return _post_github_issue_comment(project_id, repo_url, issue_number, reply)
    if normalized_provider == "gitee":
        return _post_gitee_issue_comment(project_id, repo_url, issue_number, reply)
    return IssuePostResult(posted=False, provider=normalized_provider or "unknown", error=f"unsupported provider: {normalized_provider}")
