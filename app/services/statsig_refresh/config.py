"""Statsig 定时刷新配置读取。"""

from app.core.config import get_config


def _get(key: str, default=None):
    return get_config(f"cloakbrowser.{key}", default)


def _get_int(key: str, default: int, minimum: int) -> int:
    try:
        value = int(_get(key, default) or default)
    except Exception:
        value = default
    return max(value, minimum)


def is_enabled() -> bool:
    return bool(_get("statsig_auto_refresh_enabled", False))


def get_refresh_interval() -> int:
    return _get_int("statsig_refresh_interval", 1800, 60)
