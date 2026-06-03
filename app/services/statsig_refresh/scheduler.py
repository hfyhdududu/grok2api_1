"""定时调度：周期性刷新 x-statsig-id。"""

import asyncio

from loguru import logger

from .config import get_refresh_interval, is_enabled

_task: asyncio.Task | None = None


async def refresh_once() -> bool:
    """执行一次 statsig 刷新流程。"""
    if not is_enabled():
        logger.debug("statsig_refresh disabled, skip refresh")
        return False
    try:
        from app.services.reverse.browser_bridge import refresh_browser_probe_managed

        logger.info("=" * 50)
        logger.info("开始刷新 x-statsig-id...")
        await refresh_browser_probe_managed("", True, True)
        logger.info("x-statsig-id 刷新完成")
        return True
    except Exception as exc:
        logger.error(f"x-statsig-id 刷新失败: {exc}")
        return False


async def _scheduler_loop():
    """后台调度循环。"""
    logger.info(
        f"statsig_refresh scheduler started (interval: {get_refresh_interval()}s)"
    )
    while True:
        if is_enabled():
            await refresh_once()
        else:
            logger.debug("statsig_refresh disabled, skip refresh")
        await asyncio.sleep(get_refresh_interval())


def start():
    """启动后台刷新任务。"""
    global _task
    if _task is not None:
        return
    _task = asyncio.get_event_loop().create_task(_scheduler_loop())
    logger.info("statsig_refresh background task started")


def stop():
    """停止后台刷新任务。"""
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
        logger.info("statsig_refresh background task stopped")
