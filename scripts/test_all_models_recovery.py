"""批量探测所有 public 模型是否能拿到上游有效响应（非 403 反爬）。"""
from __future__ import annotations

import asyncio
import json
import sys
import time
import traceback
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.core.config import config, register_defaults
from app.core.exceptions import AppException, UpstreamException
from app.services.grok.defaults import get_grok_defaults
from app.services.grok.services.chat import ChatService
from app.services.grok.services.model import ModelService

TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD0lEQVR42mP8z5ACBwAFgwJ/l3mZ5QAAAABJRU5ErkJggg=="
)


@dataclass
class ModelProbeResult:
    model_id: str
    kind: str
    status: str  # ok | quota | no_token | fail | error
    elapsed_sec: float
    detail: str
    preview: str = ""


def _classify_kind(model_id: str, info) -> str:
    if info.is_video:
        return "video"
    if info.is_image_edit:
        return "image_edit"
    if info.is_image:
        return "image"
    return "chat"


def _messages_for(model_id: str, kind: str) -> List[Dict[str, Any]]:
    if kind == "image_edit":
        return [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "把图片改成纯蓝色，只输出结果"},
                    {"type": "image_url", "image_url": {"url": TINY_PNG}},
                ],
            }
        ]
    if kind == "image":
        return [{"role": "user", "content": "a tiny red circle on white background"}]
    if kind == "video":
        return [{"role": "user", "content": "A white cat blinking, 2 seconds feel"}]
    return [{"role": "user", "content": f"模型 {model_id} 连通性测试，请只回复 OK"}]


def _extract_preview(result: Any) -> str:
    if isinstance(result, dict):
        try:
            choices = result.get("choices") or []
            if choices:
                msg = choices[0].get("message") or {}
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()[:200]
            return json.dumps(result, ensure_ascii=False)[:300]
        except Exception:
            return str(result)[:300]
    return str(result)[:300]


def _classify_error(exc: Exception) -> tuple[str, str]:
    text = str(exc)
    low = text.lower()
    details = getattr(exc, "details", None)
    if isinstance(details, dict):
        body = json.dumps(details, ensure_ascii=False)
        low += " " + body.lower()
        if details.get("status") == 429 or "quota" in body.lower():
            return "quota", body[:400]
        if details.get("status") == 403:
            return "fail", body[:400]
    if isinstance(exc, AppException):
        if getattr(exc, "status_code", None) == 429 or "rate_limit" in low:
            return "quota", text[:400]
        if getattr(exc, "status_code", None) == 403:
            return "fail", text[:400]
    if "no available tokens" in low:
        return "no_token", text[:400]
    if "anti-bot" in low or "code\":7" in low or "code': 7" in low:
        return "fail", text[:400]
    if "quota" in low or "429" in low:
        return "quota", text[:400]
    return "error", text[:400]


async def probe_one(model_id: str, timeout_sec: float) -> ModelProbeResult:
    info = ModelService.get(model_id)
    kind = _classify_kind(model_id, info)
    started = time.monotonic()

    async def _run():
        messages = _messages_for(model_id, kind)
        if kind == "image":
            prompt = messages[0]["content"] if messages else ""
            token_mgr = await get_token_manager()
            token = await _pick_token_for_model(model_id)
            result = await ImageGenerationService().generate(
                token_mgr=token_mgr,
                token=token,
                model_info=info,
                prompt=str(prompt),
                n=1,
                response_format="url",
                size="1024x1024",
                aspect_ratio="1:1",
                stream=False,
            )
            return {"choices": [{"message": {"content": json.dumps(result.data, ensure_ascii=False)}}]}
        if kind == "image_edit":
            prompt, image_urls = "", []
            msg = messages[0] if messages else {}
            for part in msg.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "text":
                    prompt = part.get("text") or prompt
                if isinstance(part, dict) and part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url")
                    if url:
                        image_urls.append(url)
            token_mgr = await get_token_manager()
            token = await _pick_token_for_model(model_id)
            result = await ImageEditService().edit(
                token_mgr=token_mgr,
                token=token,
                model_info=info,
                prompt=prompt or "edit",
                images=image_urls[:3],
                n=1,
                response_format="url",
                stream=False,
            )
            return {"choices": [{"message": {"content": json.dumps(result.data, ensure_ascii=False)}}]}
        if kind == "video":
            return await VideoService.completions(
                model=model_id,
                messages=messages,
                stream=False,
                aspect_ratio="1:1",
                video_length=6,
                resolution="480p",
                preset="custom",
            )
        return await ChatService.completions(
            model=model_id,
            messages=messages,
            stream=False,
        )

    try:
        result = await asyncio.wait_for(_run(), timeout=timeout_sec)
        preview = _extract_preview(result)
        elapsed = time.monotonic() - started
        if not preview:
            return ModelProbeResult(model_id, kind, "error", elapsed, "empty response", preview)
        if kind in {"image", "image_edit", "video"}:
            ok_markers = ("http", "![", "data:", "html", "mp4", "video", "image", "url")
            if any(m in preview.lower() for m in ok_markers) or len(preview) > 20:
                return ModelProbeResult(model_id, kind, "ok", elapsed, "media/chat response", preview)
        if "ok" in preview.lower() or len(preview) >= 1:
            return ModelProbeResult(model_id, kind, "ok", elapsed, "assistant reply", preview)
        return ModelProbeResult(model_id, kind, "ok", elapsed, "response received", preview)
    except asyncio.TimeoutError:
        elapsed = time.monotonic() - started
        return ModelProbeResult(model_id, kind, "error", elapsed, f"timeout>{timeout_sec}s")
    except Exception as exc:
        elapsed = time.monotonic() - started
        status, detail = _classify_error(exc)
        if status == "error":
            detail = (detail + " | " + traceback.format_exc().splitlines()[-1])[:500]
        return ModelProbeResult(model_id, kind, status, elapsed, detail)


async def main() -> int:
    register_defaults(get_grok_defaults())
    await config.load()

    models = [m.model_id for m in ModelService.list()]
    print(f"public models: {len(models)}")
    print(
        "cloakbrowser=",
        config.get("cloakbrowser.enabled"),
        "statsig_pure=",
        config.get("proxy.statsig_pure_enabled"),
        "cf=",
        bool(config.get("proxy.cf_clearance")),
    )

    results: List[ModelProbeResult] = []
    for idx, model_id in enumerate(models, 1):
        info = ModelService.get(model_id)
        kind = _classify_kind(model_id, info)
        timeout = 180.0 if kind in {"image", "image_edit", "video"} else 90.0
        print(f"[{idx}/{len(models)}] probing {model_id} ({kind}) ...", flush=True)
        row = await probe_one(model_id, timeout)
        results.append(row)
        print(f"  -> {row.status} {row.elapsed_sec:.1f}s {row.detail[:120]}", flush=True)
        await asyncio.sleep(1.0)

    summary = {
        "ok": sum(1 for r in results if r.status == "ok"),
        "quota": sum(1 for r in results if r.status == "quota"),
        "no_token": sum(1 for r in results if r.status == "no_token"),
        "fail": sum(1 for r in results if r.status == "fail"),
        "error": sum(1 for r in results if r.status == "error"),
        "total": len(results),
    }

    out_dir = ROOT / "logs"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"model_probe_{stamp}.json"
    payload = {"summary": summary, "results": [asdict(r) for r in results]}
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== SUMMARY ===")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("report:", out_path)

    for r in results:
        if r.status != "ok":
            print(f"NON-OK {r.model_id} {r.status}: {r.detail[:160]}")

    # 反爬恢复：所有非 quota/no_token 的模型都应 ok
    hard_fail = [r for r in results if r.status in {"fail", "error"}]
    return 0 if not hard_fail else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
from app.services.grok.services.image import ImageGenerationService
from app.services.grok.services.image_edit import ImageEditService
from app.services.grok.services.video import VideoService
from app.services.token.manager import get_token_manager


async def _pick_token_for_model(model_id: str) -> str:
    token_mgr = await get_token_manager()
    await token_mgr.reload_if_stale()
    quota_mode = ModelService.quota_mode_for_model(model_id)
    for pool_name in ModelService.pool_candidates_for_model(model_id):
        token = token_mgr.get_token(pool_name, quota_mode=quota_mode)
        if token:
            return token
    raise AppException(
        message="No available tokens. Please try again later.",
        error_type="rate_limit",
        code="rate_limit_exceeded",
        status_code=429,
    )
