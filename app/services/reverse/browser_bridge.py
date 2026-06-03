"""
Browser bridge client for real-browser chat upstream.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any, AsyncIterator, Dict
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from app.core.config import get_config
from app.core.exceptions import UpstreamException
from app.core.logger import logger
from app.services.browser_bridge import healthcheck as bridge_healthcheck
from app.services.browser_bridge import start as start_bridge
from app.services.browser_bridge import stop as stop_bridge

_SESSION_CACHE: dict[str, dict[str, Any]] = {}
_PROFILE_CACHE_KEY = "__profile__"
_GLOBAL_PROBE_KEY = "__global_probe__"
_PROBE_CACHE_LOADED = False
_PROBE_REFRESH_LOCK = threading.Lock()

BASE_DIR = Path(__file__).resolve().parents[3]


def _bridge_base_url() -> str:
    host = str(get_config("cloakbrowser.bridge_host", "127.0.0.1") or "127.0.0.1").strip()
    port = int(get_config("cloakbrowser.bridge_port", 9081) or 9081)
    return f"http://{host}:{port}"


def bridge_enabled() -> bool:
    return bool(get_config("cloakbrowser.enabled", False))


def bridge_chat_first() -> bool:
    return bool(
        get_config("cloakbrowser.enabled", False)
        and get_config("cloakbrowser.chat_first", True)
    )


def _bridge_timeout() -> float:
    try:
        configured = float(get_config("cloakbrowser.timeout", 120) or 120)
        first_token_timeout = float(get_config("chat.first_token_timeout", 20) or 20)
        return max(min(configured, first_token_timeout + 10), 1.0)
    except Exception:
        return 30.0


def _extract_raw_sso(token: str) -> str:
    raw = str(token or "").strip()
    return raw[4:].strip() if raw.startswith("sso=") else raw


def _probe_cache_path() -> Path:
    configured = str(
        get_config("cloakbrowser.probe_cache_file", "data/cloakbrowser-probe.json")
        or "data/cloakbrowser-probe.json"
    ).strip()
    path = Path(configured)
    if not path.is_absolute():
        path = (BASE_DIR / path).resolve()
    return path


def _probe_cache_ttl_seconds() -> float:
    try:
        return float(get_config("cloakbrowser.probe_cache_ttl_seconds", 0) or 0)
    except Exception:
        return 0.0


def _global_probe_enabled() -> bool:
    return bool(get_config("cloakbrowser.global_probe", True))


def _manual_statsig_configured() -> bool:
    return bool(str(get_config("cloakbrowser.manual_statsig_id", "") or "").strip())


def _has_reusable_probe_source() -> bool:
    if _manual_statsig_configured():
        return True
    probe = _load_global_probe()
    return bool(probe and probe.get("x_statsig_id") and probe.get("request_headers"))


def _cached_probe_session_payload() -> Dict[str, Any]:
    probe = _load_global_probe()
    if not probe:
        return {}
    return {
        "request_headers": probe.get("request_headers") or {},
        "x_statsig_id": probe.get("x_statsig_id") or "",
        "user_agent": probe.get("user_agent") or "",
        "captured_at": probe.get("captured_at") or "",
        "probe_source": "global",
    }


async def _ensure_bridge_started() -> None:
    if await bridge_healthcheck():
        return
    await start_bridge()


async def _stop_bridge_after_refresh() -> None:
    try:
        await stop_bridge()
    except Exception as exc:
        logger.warning(f"Stop browser bridge after refresh failed: {exc}")


def _request_sync(sso: str, payload: Dict[str, Any], conversation_id: str = "") -> str:
    body = json.dumps(
        {
            "sso": sso,
            "payload": payload,
            "conversation_id": conversation_id,
        }
    ).encode("utf-8")
    req = urllib_request.Request(
        f"{_bridge_base_url()}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=_bridge_timeout()) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        payload_text = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(payload_text)
        except Exception:
            parsed = {}
        code = str(parsed.get("code") or "bridge_error")
        raise UpstreamException(
            message=str(parsed.get("error") or f"Browser bridge failed, {exc.code}"),
            details={
                "status": exc.code,
                "bridge_code": code,
                "body": payload_text,
            },
            status_code=exc.code,
        ) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise UpstreamException(
            message=f"Browser bridge unavailable: {exc}",
            details={
                "status": 503,
                "bridge_code": "bridge_unavailable",
                "error": str(exc),
            },
            status_code=503,
        ) from exc


def _session_request_sync(sso: str = "") -> Dict[str, Any]:
    suffix = f"?sso={quote(sso)}" if sso else ""
    req = urllib_request.Request(f"{_bridge_base_url()}/api/session{suffix}", method="GET")
    try:
        with urllib_request.urlopen(req, timeout=_bridge_timeout()) as resp:
            payload_text = resp.read().decode("utf-8", errors="replace")
            data = json.loads(payload_text) if payload_text else {}
            return data if isinstance(data, dict) else {}
    except HTTPError as exc:
        payload_text = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(payload_text)
        except Exception:
            parsed = {}
        raise UpstreamException(
            message=str(parsed.get("error") or f"Browser session fetch failed, {exc.code}"),
            details={"status": exc.code, "bridge_code": str(parsed.get("code") or "bridge_error")},
            status_code=exc.code,
        ) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise UpstreamException(
            message=f"Browser bridge unavailable: {exc}",
            details={"status": 503, "bridge_code": "bridge_unavailable", "error": str(exc)},
            status_code=503,
        ) from exc


def _probe_request_sync(sso: str = "", force: bool = False) -> Dict[str, Any]:
    payload: dict[str, Any] = {}
    if sso:
        payload["sso"] = sso
    if force:
        payload["force"] = True
    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        f"{_bridge_base_url()}/api/probe",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=_bridge_timeout()) as resp:
            payload_text = resp.read().decode("utf-8", errors="replace")
            data = json.loads(payload_text) if payload_text else {}
            return data if isinstance(data, dict) else {}
    except HTTPError as exc:
        payload_text = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(payload_text)
        except Exception:
            parsed = {}
        raise UpstreamException(
            message=str(parsed.get("error") or f"Browser session probe failed, {exc.code}"),
            details={
                "status": exc.code,
                "bridge_code": str(parsed.get("code") or "bridge_error"),
                "body": payload_text,
            },
            status_code=exc.code,
        ) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise UpstreamException(
            message=f"Browser bridge unavailable: {exc}",
            details={"status": 503, "bridge_code": "bridge_unavailable", "error": str(exc)},
            status_code=503,
        ) from exc


def _has_captured_app_chat_headers(data: Dict[str, Any]) -> bool:
    request_headers = data.get("request_headers") if isinstance(data, dict) else None
    return bool(
        data
        and data.get("x_statsig_id")
        and isinstance(request_headers, dict)
        and request_headers
    )


def _normalize_probe_snapshot(data: Dict[str, Any]) -> Dict[str, Any]:
    request_headers = data.get("request_headers") if isinstance(data, dict) else None
    if not isinstance(request_headers, dict):
        request_headers = {}
    statsig = str(data.get("x_statsig_id") or request_headers.get("x-statsig-id") or "").strip()
    if not statsig or not request_headers:
        return {}
    return {
        "request_headers": request_headers,
        "x_statsig_id": statsig,
        "user_agent": str(data.get("user_agent") or "").strip(),
        "captured_at": data.get("captured_at") or "",
        "saved_at": time.time(),
    }


def _load_global_probe() -> Dict[str, Any]:
    global _PROBE_CACHE_LOADED
    if not _global_probe_enabled():
        return {}
    cached = _SESSION_CACHE.get(_GLOBAL_PROBE_KEY) or {}
    if cached:
        return cached
    if _PROBE_CACHE_LOADED:
        return {}
    _PROBE_CACHE_LOADED = True
    path = _probe_cache_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning(f"Browser global probe cache load failed: {exc}")
        return {}
    if not isinstance(data, dict):
        return {}
    ttl = _probe_cache_ttl_seconds()
    saved_at = float(data.get("saved_at") or 0)
    if ttl > 0 and saved_at > 0 and time.time() - saved_at > ttl:
        logger.info("Browser global probe cache expired")
        return {}
    probe = _normalize_probe_snapshot(data)
    if probe:
        _SESSION_CACHE[_GLOBAL_PROBE_KEY] = probe
        logger.info(
            "Browser global probe cache loaded: "
            f"statsig=yes, header_keys={len(probe.get('request_headers') or {})}"
        )
    return probe


def get_cached_global_probe() -> Dict[str, Any]:
    """Return persisted or in-memory global probe without contacting the browser bridge."""
    return _load_global_probe()


def _save_global_probe(data: Dict[str, Any]) -> Dict[str, Any]:
    if not _global_probe_enabled():
        return {}
    probe = _normalize_probe_snapshot(data)
    if not probe:
        return {}
    _SESSION_CACHE[_GLOBAL_PROBE_KEY] = probe
    path = _probe_cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(probe, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(path)
        logger.info(
            "Browser global probe cache saved: "
            f"statsig=yes, header_keys={len(probe.get('request_headers') or {})}"
        )
    except Exception as exc:
        logger.warning(f"Browser global probe cache save failed: {exc}")
    return probe


def _clear_global_probe_cache() -> None:
    global _PROBE_CACHE_LOADED
    _SESSION_CACHE.pop(_GLOBAL_PROBE_KEY, None)
    _PROBE_CACHE_LOADED = False
    try:
        _probe_cache_path().unlink(missing_ok=True)
    except Exception as exc:
        logger.warning(f"Browser global probe cache delete failed: {exc}")


def _clear_session_probe_cache() -> None:
    """Drop stale per-session probe headers so the next request merges the fresh global probe."""
    for key in list(_SESSION_CACHE.keys()):
        if key == _GLOBAL_PROBE_KEY:
            continue
        _SESSION_CACHE.pop(key, None)


def _merge_global_probe(data: Dict[str, Any]) -> Dict[str, Any]:
    if not data or _has_captured_app_chat_headers(data):
        return data
    probe = _load_global_probe()
    if not probe:
        return data
    merged = dict(data)
    merged["request_headers"] = probe.get("request_headers") or {}
    merged["x_statsig_id"] = probe.get("x_statsig_id") or ""
    if not merged.get("user_agent") and probe.get("user_agent"):
        merged["user_agent"] = probe.get("user_agent")
    merged["probe_source"] = "global"
    return merged


def _cache_session(key: str, data: Dict[str, Any]) -> Dict[str, Any]:
    if not data:
        return data
    now = time.time()
    data["_cached_at"] = now
    if _has_captured_app_chat_headers(data):
        _save_global_probe(data)
    _SESSION_CACHE[key] = data
    sso = _extract_raw_sso(str(data.get("sso") or ""))
    if sso:
        _SESSION_CACHE[sso] = data
    return data


def get_browser_session(token: str, max_age_seconds: int = 120, force_refresh: bool = False) -> Dict[str, Any]:
    sso = _extract_raw_sso(token)
    if not sso or not bridge_enabled() or not get_config("cloakbrowser.sync_session", True):
        return {}
    cached = _SESSION_CACHE.get(sso) or {}
    now = time.time()
    if (not force_refresh) and cached and (now - float(cached.get("_cached_at", 0))) <= max_age_seconds:
        return cached
    if not force_refresh:
        cached_probe = _cached_probe_session_payload()
        if cached_probe:
            logger.info("Browser session sync skipped live bridge fetch: using cached global probe")
            return cached_probe
    data = _session_request_sync(sso)
    if data:
        data = _merge_global_probe(data)
        _cache_session(sso, data)
        logger.info(
            "Browser session synced: "
            f"cookie_len={len(str(data.get('cookie_header') or ''))}, "
            f"ua={'yes' if data.get('user_agent') else 'no'}, "
            f"statsig={'yes' if data.get('x_statsig_id') else 'no'}, "
            f"probe_source={data.get('probe_source') or 'session'}"
        )
    else:
        logger.warning("Browser session sync returned empty payload")
    return data


def get_browser_profile_session(max_age_seconds: int = 120, force_refresh: bool = False) -> Dict[str, Any]:
    if not bridge_enabled() or not get_config("cloakbrowser.sync_session", True):
        return {}
    cached = _SESSION_CACHE.get(_PROFILE_CACHE_KEY) or {}
    now = time.time()
    if (not force_refresh) and cached and (now - float(cached.get("_cached_at", 0))) <= max_age_seconds:
        return cached
    if not force_refresh:
        cached_probe = _cached_probe_session_payload()
        if cached_probe:
            logger.info("Browser profile session sync skipped live bridge fetch: using cached global probe")
            return cached_probe
    data = _session_request_sync("")
    if data:
        data = _merge_global_probe(data)
        _cache_session(_PROFILE_CACHE_KEY, data)
        logger.info(
            "Browser profile session synced: "
            f"sso={'yes' if data.get('sso') else 'no'}, "
            f"cookie_len={len(str(data.get('cookie_header') or ''))}, "
            f"ua={'yes' if data.get('user_agent') else 'no'}, "
            f"statsig={'yes' if data.get('x_statsig_id') else 'no'}, "
            f"probe_source={data.get('probe_source') or 'session'}"
        )
    else:
        logger.warning("Browser profile session sync returned empty payload")
    return data


def refresh_browser_probe(token: str = "", wait: bool = True) -> Dict[str, Any]:
    sso = _extract_raw_sso(token)
    if not bridge_enabled() or not get_config("cloakbrowser.sync_session", True):
        return {}
    acquired = _PROBE_REFRESH_LOCK.acquire(blocking=wait)
    if not acquired:
        logger.info("Browser probe refresh skipped: another refresh is already running")
        return {}
    try:
        probe_data = _probe_request_sync(sso, force=True)
        if probe_data:
            _clear_global_probe_cache()
            _clear_session_probe_cache()
            key = sso or _PROFILE_CACHE_KEY
            _cache_session(key, probe_data)
            logger.info(
                "Browser probe force refreshed: "
                f"cookie_len={len(str(probe_data.get('cookie_header') or ''))}, "
                f"ua={'yes' if probe_data.get('user_agent') else 'no'}, "
                f"statsig={'yes' if probe_data.get('x_statsig_id') else 'no'}, "
                f"header_keys={len((probe_data.get('request_headers') or {}) if isinstance(probe_data.get('request_headers'), dict) else {})}"
            )
        return probe_data
    finally:
        _PROBE_REFRESH_LOCK.release()


async def refresh_browser_probe_managed(token: str = "", wait: bool = True, shutdown_after: bool = True) -> Dict[str, Any]:
    """Start bridge on demand, refresh probe once, then optionally stop it."""
    await _ensure_bridge_started()
    try:
        return await asyncio.to_thread(refresh_browser_probe, token, wait)
    finally:
        if shutdown_after:
            await _stop_bridge_after_refresh()


def wait_for_browser_probe_refresh(timeout_seconds: float = 8.0) -> bool:
    """Wait briefly when a background probe refresh is already preparing fresher headers."""
    if not bridge_enabled() or not get_config("cloakbrowser.sync_session", True):
        return True
    try:
        timeout = max(float(timeout_seconds or 0), 0.0)
    except Exception:
        timeout = 8.0
    acquired = _PROBE_REFRESH_LOCK.acquire(timeout=timeout)
    if not acquired:
        logger.warning(f"Browser probe refresh wait timed out after {timeout:.1f}s")
        return False
    _PROBE_REFRESH_LOCK.release()
    return True


async def warmup_browser_session(token: str) -> Dict[str, Any]:
    sso = _extract_raw_sso(token)
    data = await asyncio.to_thread(get_browser_session, token, 120, False)
    if not sso or _has_captured_app_chat_headers(data):
        return data
    return data


async def _collect_configured_tokens() -> list[str]:
    try:
        from app.services.token.manager import get_token_manager

        manager = await get_token_manager()
        tokens: list[str] = []
        for pool in manager.pools.values():
            for info in pool.list():
                token = str(getattr(info, "token", "") or "").strip()
                if token:
                    tokens.append(token)
        return tokens
    except Exception as exc:
        logger.warning(f"Browser session prewarm token scan failed: {exc}")
        return []


async def prewarm_browser_sessions() -> None:
    if not bridge_enabled() or not get_config("cloakbrowser.sync_session", True):
        return
    if not get_config("cloakbrowser.prewarm_on_start", True):
        return
    if _has_reusable_probe_source():
        logger.info("Browser session prewarm skipped: existing manual statsig or reusable probe cache found")
        return

    mode = str(get_config("cloakbrowser.prewarm_mode", "session") or "session").strip().lower()
    if mode == "probe" and _global_probe_enabled():
        logger.info("Browser session prewarm started: mode=probe, strategy=single_global_probe")
        try:
            if get_config("cloakbrowser.profile_session", True):
                await asyncio.to_thread(get_browser_profile_session, 0, True)
            probe_data = await asyncio.to_thread(refresh_browser_probe, "", True)
            logger.info(
                "Browser session prewarm completed: "
                f"strategy=single_global_probe, statsig={'yes' if (probe_data or {}).get('x_statsig_id') else 'no'}"
            )
        except Exception as exc:
            logger.warning(
                "Browser global probe prewarm skipped: "
                f"{exc}. 应用将继续启动，并在首次真实对话时再尝试获取 probe。"
            )
        return

    configured_tokens = await _collect_configured_tokens()
    tokens = list(dict.fromkeys(_extract_raw_sso(token) for token in configured_tokens))
    tokens = [token for token in tokens if token]

    if get_config("cloakbrowser.profile_session", True):
        try:
            profile_data = await asyncio.to_thread(get_browser_profile_session, 0, True)
            profile_sso = _extract_raw_sso(str((profile_data or {}).get("sso") or ""))
            if profile_sso and profile_sso not in tokens:
                tokens.append(profile_sso)
        except Exception as exc:
            logger.warning(f"Browser profile session prewarm failed: {exc}")

    if not tokens:
        logger.info("Browser session prewarm skipped: no configured or profile sso token")
        return

    concurrency = max(int(get_config("cloakbrowser.prewarm_concurrency", 1) or 1), 1)
    semaphore = asyncio.Semaphore(concurrency)
    logger.info(f"Browser session prewarm started: tokens={len(tokens)}, mode={mode}")

    async def _one(token: str) -> None:
        async with semaphore:
            try:
                if mode == "probe":
                    await warmup_browser_session(token)
                else:
                    await asyncio.to_thread(get_browser_session, token, 0, True)
            except Exception as exc:
                logger.warning(f"Browser session prewarm failed for token: {exc}")

    await asyncio.gather(*[_one(token) for token in tokens])
    logger.info("Browser session prewarm completed")


async def request_browser_bridge(
    token: str,
    payload: Dict[str, Any],
    conversation_id: str = "",
) -> AsyncIterator[str]:
    sso = _extract_raw_sso(token)
    if not sso:
        raise UpstreamException(
            message="Browser bridge requires a valid sso token",
            details={"status": 401, "bridge_code": "sso_unavailable"},
            status_code=401,
        )

    logger.info("BrowserBridge: forwarding Grok app-chat via real browser")
    body = await asyncio.to_thread(_request_sync, sso, payload, conversation_id)
    for raw_line in body.splitlines():
        line = str(raw_line or "").strip()
        if line:
            yield line
