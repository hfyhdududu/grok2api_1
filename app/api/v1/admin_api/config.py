import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import verify_app_key
from app.core.config import config
from app.core.logger import logger, LOG_DIR
from app.services.grok.services.model import ModelService
from app.services.token import get_token_manager
from app.core.storage import (
    get_storage as get_storage_backend,
    LocalStorage,
    RedisStorage,
    SQLStorage,
)
from app.services.cf_refresh.scheduler import refresh_once
from app.services.reverse.browser_bridge import (
    bridge_enabled as browser_bridge_enabled,
    get_cached_global_probe,
    get_browser_profile_session,
    refresh_browser_probe_managed,
)

router = APIRouter()


def _clear_log_dir() -> dict:
    """清空日志目录内容，保留目录本身。"""
    log_dir = Path(LOG_DIR)
    log_dir.mkdir(parents=True, exist_ok=True)
    deleted_files = 0
    deleted_dirs = 0
    released_bytes = 0

    for child in log_dir.iterdir():
        try:
            if child.is_file() or child.is_symlink():
                try:
                    released_bytes += child.stat().st_size
                except OSError:
                    pass
                child.unlink(missing_ok=True)
                deleted_files += 1
                continue
            if child.is_dir():
                for nested in child.rglob("*"):
                    if nested.is_file():
                        try:
                            released_bytes += nested.stat().st_size
                        except OSError:
                            pass
                shutil.rmtree(child, ignore_errors=False)
                deleted_dirs += 1
        except FileNotFoundError:
            continue

    return {
        "log_dir": str(log_dir),
        "deleted_files": deleted_files,
        "deleted_dirs": deleted_dirs,
        "released_bytes": released_bytes,
    }


@router.get("/verify", dependencies=[Depends(verify_app_key)])
async def admin_verify():
    """验证后台访问密钥（app_key）"""
    return {"status": "success"}


@router.get("/config", dependencies=[Depends(verify_app_key)])
async def get_config():
    """获取当前配置"""
    # 暴露原始配置字典
    return config._config


@router.post("/config", dependencies=[Depends(verify_app_key)])
async def update_config(data: dict):
    """更新配置"""
    try:
        await config.update(data)
        return {"status": "success", "message": "配置已更新"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config/cf-refresh", dependencies=[Depends(verify_app_key)])
async def refresh_cf_clearance():
    """手动刷新 cf_clearance。"""
    try:
        success = await refresh_once()
        if not success:
            raise HTTPException(status_code=500, detail="刷新失败，请检查 FlareSolverr、代理和网络配置")
        proxy_conf = (config._config or {}).get("proxy", {}) if isinstance(config._config, dict) else {}
        return {
            "status": "success",
            "message": "CF Clearance 已刷新",
            "data": {
                "browser": proxy_conf.get("browser") or "",
                "user_agent": proxy_conf.get("user_agent") or "",
                "has_cf_clearance": bool(proxy_conf.get("cf_clearance")),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Manual cf_clearance refresh failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _current_statsig_payload() -> dict:
    manual_statsig = str(config.get("cloakbrowser.manual_statsig_id", "") or "").strip()
    session_data = {}
    probe_data = get_cached_global_probe() if browser_bridge_enabled() else {}
    request_headers = {}

    try:
        session_data = get_browser_profile_session(0, False) if browser_bridge_enabled() else {}
    except Exception as exc:
        logger.info(f"Statsig status read skipped live browser bridge fetch: {exc}")

    if isinstance(session_data, dict) and isinstance(session_data.get("request_headers"), dict):
        request_headers = session_data.get("request_headers") or {}
    elif isinstance(probe_data, dict) and isinstance(probe_data.get("request_headers"), dict):
        request_headers = probe_data.get("request_headers") or {}

    request_headers = (
        request_headers if isinstance(request_headers, dict) else {}
    )
    statsig = str(
        (session_data or {}).get("x_statsig_id")
        or (probe_data or {}).get("x_statsig_id")
        or request_headers.get("x-statsig-id")
        or ""
    ).strip()
    return {
        "enabled": browser_bridge_enabled(),
        "x_statsig_id": statsig,
        "manual_statsig_id": manual_statsig,
        "effective_statsig_id": manual_statsig or statsig,
        "captured_at": (session_data or {}).get("captured_at") or (probe_data or {}).get("captured_at") or "",
        "user_agent": (session_data or {}).get("user_agent") or (probe_data or {}).get("user_agent") or "",
        "header_keys": sorted(request_headers.keys()) if request_headers else [],
    }


@router.get("/config/statsig", dependencies=[Depends(verify_app_key)])
async def get_statsig_status():
    """获取当前浏览器探针捕获到的 x-statsig-id。"""
    try:
        return {
            "status": "success",
            "message": "已获取当前 x-statsig-id",
            "data": _current_statsig_payload(),
        }
    except Exception as e:
        logger.error(f"Get current x-statsig-id failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config/statsig-refresh", dependencies=[Depends(verify_app_key)])
async def refresh_statsig():
    """手动刷新浏览器探针并获取新的 x-statsig-id。"""
    if not browser_bridge_enabled():
        raise HTTPException(status_code=400, detail="CloakBrowser bridge 未启用")
    try:
        await refresh_browser_probe_managed("", True, reason="manual")
        return {
            "status": "success",
            "message": "x-statsig-id 已刷新",
            "data": _current_statsig_payload(),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Manual x-statsig-id refresh failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config/statsig-manual", dependencies=[Depends(verify_app_key)])
async def update_manual_statsig(data: dict):
    """手动设置/清空 x-statsig-id。"""
    try:
        value = str((data or {}).get("manual_statsig_id") or "").strip()
        await config.update({"cloakbrowser": {"manual_statsig_id": value}})
        return {
            "status": "success",
            "message": "手动 x-statsig-id 已更新" if value else "手动 x-statsig-id 已清空",
            "data": _current_statsig_payload(),
        }
    except Exception as e:
        logger.error(f"Update manual x-statsig-id failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config/clear-logs", dependencies=[Depends(verify_app_key)])
async def clear_logs():
    """清空日志目录。"""
    try:
        result = _clear_log_dir()
        return {
            "status": "success",
            "message": "日志文件夹已清空",
            "data": result,
        }
    except Exception as e:
        logger.error(f"Clear log directory failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/model-routing/meta", dependencies=[Depends(verify_app_key)])
async def get_model_routing_meta():
    """获取模型池路由界面所需的模型与池元数据。"""
    token_mgr = await get_token_manager()
    pool_names = set(token_mgr.pools.keys())
    pool_names.update({"ssoBasic", "ssoSuper", "ssoHeavy"})

    models = [
        {
            "id": item.model_id,
            "display_name": item.display_name,
        }
        for item in ModelService.list()
    ]

    return {
        "models": models,
        "pools": sorted(pool_names),
    }


@router.get("/storage", dependencies=[Depends(verify_app_key)])
async def admin_get_storage():
    """获取当前存储模式"""
    storage_type = os.getenv("SERVER_STORAGE_TYPE", "").lower()
    if not storage_type:
        storage = get_storage_backend()
        if isinstance(storage, LocalStorage):
            storage_type = "local"
        elif isinstance(storage, RedisStorage):
            storage_type = "redis"
        elif isinstance(storage, SQLStorage):
            storage_type = {
                "mysql": "mysql",
                "mariadb": "mysql",
                "postgres": "pgsql",
                "postgresql": "pgsql",
                "pgsql": "pgsql",
            }.get(storage.dialect, storage.dialect)
    return {"type": storage_type or "local"}
