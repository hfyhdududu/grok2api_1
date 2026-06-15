"""配置管理 — 从 app config 的 proxy.* 读取，支持面板修改实时生效"""

import re
import time

GROK_URL = "https://grok.com"


def _get(key: str, default=None):
    """从 app config 读取 proxy.* 配置"""
    from app.core.config import get_config
    return get_config(f"proxy.{key}", default)


def get_flaresolverr_url() -> str:
    return _get("flaresolverr_url", "") or ""


def _get_int(key: str, default: int, min_value: int) -> int:
    raw = _get(key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return max(default, min_value)
    if value < min_value:
        return min_value
    return value


def get_refresh_interval() -> int:
    return _get_int("refresh_interval", 600, 60)


def get_timeout() -> int:
    return _get_int("timeout", 60, 60)


def get_proxy() -> str:
    """使用基础代理 URL，保证出口 IP 一致"""
    return _get("base_proxy_url", "") or ""


def is_enabled() -> bool:
    return bool(_get("enabled", False))


def _parse_clearance_from_cookie_blob(cookie_blob: str) -> str:
    match = re.search(r"(?:^|;\s*)cf_clearance=([^;]+)", str(cookie_blob or ""))
    return match.group(1).strip() if match else ""


def _clearance_expiry_ts(clearance: str) -> int | None:
    match = re.search(r"-(\d{10})-", str(clearance or ""))
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def get_cf_clearance_value() -> str:
    """读取当前配置中的 cf_clearance，优先使用 cf_cookies 里的最新值。"""
    cookie_blob = get_cf_cookies_value()
    from_blob = _parse_clearance_from_cookie_blob(cookie_blob)
    field_value = str(_get("cf_clearance", "") or "").strip()
    if from_blob and field_value and from_blob != field_value:
        return from_blob
    if from_blob:
        return from_blob
    return field_value


def get_cf_cookies_value() -> str:
    return str(_get("cf_cookies", "") or "").strip()


def is_cf_clearance_usable(*, skew_seconds: int = 0) -> bool:
    """判断当前配置里的 cf_clearance 是否仍可复用。"""
    clearance = get_cf_clearance_value()
    if not clearance:
        return False
    expiry = _clearance_expiry_ts(clearance)
    if expiry is None:
        return True
    return time.time() < expiry - skew_seconds
