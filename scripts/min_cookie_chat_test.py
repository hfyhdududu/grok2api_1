"""最小会话探测：使用导出的 Cookie JSON 直连 Grok app-chat。"""
import json
import sys
import uuid
from pathlib import Path

import orjson
from curl_cffi.requests import AsyncSession

ROOT = Path(__file__).resolve().parent.parent
COOKIE_JSON = Path(
    r"C:\Users\xianyu\.codex\attachments\a5833e19-6c80-48d8-b774-c8c20a2c486f\pasted-text.txt"
)
CHAT_URL = "https://grok.com/rest/app-chat/conversations/new"


def cookies_to_header(items: list) -> str:
    parts = []
    for item in items:
        name = str(item.get("name") or "").strip()
        value = str(item.get("value") or "").strip()
        if name and value:
            parts.append(f"{name}={value}")
    return "; ".join(parts)


def extract_sso(items: list) -> str:
    for item in items:
        if item.get("name") in ("sso-rw", "sso"):
            return str(item.get("value") or "").strip()
    return ""


def build_base_headers(cookie_header: str, statsig: str) -> dict:
    return {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Content-Type": "application/json",
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-statsig-id": statsig,
        "x-xai-request-id": str(uuid.uuid4()),
        "Cookie": cookie_header,
    }


async def main() -> int:
    items = json.loads(COOKIE_JSON.read_text(encoding="utf-8"))
    cookie_header = cookies_to_header(items)
    sso = extract_sso(items)
    names = {x.get("name") for x in items}
    print("cookie_names:", sorted(names))
    print("has cf_clearance:", "cf_clearance" in names)
    print("sso present:", bool(sso), "len", len(sso))

    sys.path.insert(0, str(ROOT))
    from app.services.reverse.utils.statsig import StatsigGenerator

    statsig = StatsigGenerator.gen_id(sso)
    headers = build_base_headers(cookie_header, statsig)

    payload = {
        "temporary": True,
        "disableMemory": True,
        "message": "你好，这是一次 cookie 最小测试，请只回复 OK。",
        "modelName": "grok-3",
        "toolOverrides": {},
        "enableSideBySide": True,
        "responseMetadata": {"experiments": []},
    }

    async with AsyncSession() as session:
        rl = await session.post(
            "https://grok.com/rest/rate-limits",
            headers=build_base_headers(cookie_header, StatsigGenerator.gen_id(sso)),
            data=orjson.dumps({}),
            timeout=30,
            impersonate="chrome136",
        )
        print("rate-limits status:", rl.status_code, "body:", rl.text[:300])

        print("POST", CHAT_URL)
        resp = await session.post(
            CHAT_URL,
            headers=headers,
            data=orjson.dumps(payload),
            timeout=60,
            stream=True,
            impersonate="chrome136",
        )
        print("chat status:", resp.status_code)
        print("content-type:", resp.headers.get("content-type"))
        body_chunks = []
        try:
            async for chunk in resp.aiter_content():
                if chunk:
                    body_chunks.append(chunk)
                if sum(len(c) for c in body_chunks) > 8000:
                    break
        except Exception as e:
            print("stream read error:", e)
        body = b"".join(body_chunks).decode("utf-8", errors="replace")
        print("body_preview:", body[:2000])
        ok = resp.status_code == 200 and ("data:" in body or len(body) > 20)
        print("RESULT:", "SUCCESS" if ok else "FAILED")
        return 0 if ok else 1


if __name__ == "__main__":
    import asyncio

    raise SystemExit(asyncio.run(main()))
