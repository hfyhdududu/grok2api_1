"""定时调度：周期性刷新 cf_clearance（集成到 grok2api 进程内）"""

import asyncio
import time

from loguru import logger

from .config import (
    get_refresh_interval,
    get_flaresolverr_url,
    is_cf_clearance_usable,
    is_enabled,
)
from .solver import solve_cf_challenge

_task: asyncio.Task | None = None
_initial_refresh_event: asyncio.Event | None = None
_initial_refresh_success = False
_last_cf_refresh_at: float = 0.0


def seconds_since_cf_refresh() -> float | None:
    """返回距离上次 cf_refresh 成功刷新的秒数；未刷新过则返回 None。"""
    if _last_cf_refresh_at <= 0:
        return None
    return max(time.time() - _last_cf_refresh_at, 0.0)


async def _update_app_config(
    cf_cookies: str,
    user_agent: str = "",
    browser: str = "",
    cf_clearance: str = "",
) -> bool:
    """直接更新 grok2api 的运行时配置"""
    try:
        from app.core.config import config
        from .config import _parse_clearance_from_cookie_blob

        resolved_clearance = str(cf_clearance or "").strip() or _parse_clearance_from_cookie_blob(cf_cookies)
        proxy_update = {"cf_cookies": cf_cookies}
        if resolved_clearance:
            proxy_update["cf_clearance"] = resolved_clearance
        if user_agent:
            proxy_update["user_agent"] = user_agent
        if browser:
            proxy_update["browser"] = browser

        await config.update({"proxy": proxy_update})

        logger.info(f"配置已更新: cf_cookies (长度 {len(cf_cookies)}), 指纹: {browser}")
        if user_agent:
            logger.info(f"配置已更新: user_agent = {user_agent}")
        return True
    except Exception as e:
        logger.error(f"更新配置失败: {e}")
        return False


async def refresh_once() -> bool:
    """执行一次刷新流程"""
    global _initial_refresh_success, _last_cf_refresh_at
    logger.info("=" * 50)
    logger.info("开始刷新 cf_clearance...")

    result = await solve_cf_challenge()
    if not result:
        logger.error("刷新失败：无法获取 cf_clearance")
        return False

    success = await _update_app_config(
        cf_cookies=result["cookies"],
        cf_clearance=result.get("cf_clearance", ""),
        user_agent=result.get("user_agent", ""),
        browser=result.get("browser", ""),
    )

    if success:
        _initial_refresh_success = True
        _last_cf_refresh_at = time.time()
        logger.info("刷新完成")
    else:
        logger.error("刷新失败: 更新配置失败")

    return success


async def _scheduler_loop():
    """后台调度循环"""
    global _initial_refresh_event
    logger.info(
        f"cf_refresh scheduler started (FlareSolverr: {get_flaresolverr_url()}, interval: {get_refresh_interval()}s)"
    )

    # 周期性刷新（每次循环重新读取配置，支持面板修改实时生效）
    while True:
        if is_enabled():
            await refresh_once()
            if _initial_refresh_event and not _initial_refresh_event.is_set():
                _initial_refresh_event.set()
        else:
            logger.debug("cf_refresh disabled, skip refresh")
            if _initial_refresh_event and not _initial_refresh_event.is_set():
                _initial_refresh_event.set()
        interval = get_refresh_interval()
        await asyncio.sleep(interval)


async def wait_for_initial_cf_refresh(timeout: float = 120.0) -> bool:
    """等待启动后的首次 CF 刷新完成；若配置里已有可用 clearance 则直接复用。"""
    global _initial_refresh_event
    if is_cf_clearance_usable():
        logger.info("CF clearance 已存在于配置中，probe 将直接复用，无需等待 FlareSolverr")
        return True
    if not is_enabled():
        logger.debug("CF 自动刷新未启用，跳过启动等待")
        if _initial_refresh_event and not _initial_refresh_event.is_set():
            _initial_refresh_event.set()
        return is_cf_clearance_usable()
    if _initial_refresh_event is None:
        _initial_refresh_event = asyncio.Event()
    if not _initial_refresh_event.is_set():
        try:
            await asyncio.wait_for(_initial_refresh_event.wait(), timeout=max(timeout, 1.0))
        except asyncio.TimeoutError:
            logger.warning(f"等待启动 CF 刷新超时（{timeout:.0f}s）")
    for _ in range(10):
        if is_cf_clearance_usable():
            logger.info("启动 CF 刷新完成，probe 将复用 cf_refresh 结果")
            return True
        await asyncio.sleep(0.05)
    if _initial_refresh_success:
        logger.info("启动 CF 刷新已成功，probe 将复用 cf_refresh 写入的 cookie")
        return True
    return is_cf_clearance_usable()


def start():
    """启动后台刷新任务"""
    global _task, _initial_refresh_event
    if _task is not None:
        return
    _initial_refresh_event = asyncio.Event()
    _task = asyncio.get_event_loop().create_task(_scheduler_loop())
    logger.info("cf_refresh background task started")


def stop():
    """停止后台刷新任务"""
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
        logger.info("cf_refresh background task stopped")
