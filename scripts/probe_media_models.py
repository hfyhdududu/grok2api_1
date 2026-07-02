"""仅探测 imagine 类模型（走 HTTP /v1/chat/completions 与 chat 路由一致）。"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.core.config import config, register_defaults
from app.services.grok.defaults import get_grok_defaults
from app.services.grok.services.model import ModelService

TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD0lEQVR42mP8z5ACBwAFgwJ/l3mZ5QAAAABJRU5ErkJggg=="
)

MEDIA_IDS = [
    "grok-imagine-image-lite",
    "grok-imagine-image",
    "grok-imagine-image-pro",
    "grok-imagine-image-edit",
    "grok-imagine-video",
]


async def probe_one(client: httpx.AsyncClient, api_key: str, model_id: str) -> dict:
    info = ModelService.get(model_id)
    body: dict = {
        "model": model_id,
        "stream": False,
        "messages": [{"role": "user", "content": "tiny red circle on white background"}],
    }
    if info and info.is_image_edit:
        body["messages"] = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "make it blue"},
                    {"type": "image_url", "image_url": {"url": TINY_PNG}},
                ],
            }
        ]
    elif info and info.is_video:
        body["video_config"] = {
            "aspect_ratio": "1:1",
            "video_length": 6,
            "resolution_name": "480p",
            "preset": "custom",
            "n": 1,
        }
    else:
        body["image_config"] = {"n": 1, "size": "1024x1024", "response_format": "url"}

    r = await client.post(
        "http://127.0.0.1:8000/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=body,
    )
    text = r.text
    status = "ok" if r.status_code == 200 else "fail"
    detail = f"http {r.status_code}"
    if r.status_code != 200:
        detail += " " + text[:300]
    else:
        try:
            data = r.json()
            content = (
                (data.get("choices") or [{}])[0]
                .get("message", {})
                .get("content", "")
            )
            if not str(content).strip():
                status = "error"
                detail = "empty content"
            else:
                detail = str(content)[:120]
        except Exception as e:
            status = "error"
            detail = str(e)
    return {"model_id": model_id, "status": status, "detail": detail}


async def main() -> int:
    register_defaults(get_grok_defaults())
    await config.load()
    api_key = str(config.get("app.api_key") or "").strip()
    if not api_key:
        print("missing app.api_key")
        return 2

    print("media probe via http, statsig_pure=", config.get("proxy.statsig_pure_enabled"))
    results = []
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for mid in MEDIA_IDS:
            print(f"probing {mid} ...", flush=True)
            try:
                row = await probe_one(client, api_key, mid)
            except Exception as e:
                row = {"model_id": mid, "status": "error", "detail": str(e)[:300]}
            results.append(row)
            print(f"  -> {row['status']} {row['detail'][:100]}", flush=True)

    out = ROOT / "logs" / "media_probe_latest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("report:", out)
    hard = [r for r in results if r["status"] in {"fail", "error"}]
    return 0 if not hard else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
