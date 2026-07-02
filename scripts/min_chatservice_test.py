"""通过 ChatService 走完整业务链测试（无需单独起 HTTP 若沙箱限制）。"""
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.core.config import config, register_defaults
from app.services.grok.defaults import get_grok_defaults
from app.services.grok.services.chat import ChatService


async def main() -> int:
    register_defaults(get_grok_defaults())
    await config.load()
    print(
        "cloakbrowser.enabled=",
        config.get("cloakbrowser.enabled"),
        "statsig_pure=",
        config.get("proxy.statsig_pure_enabled"),
        "cf=",
        bool(config.get("proxy.cf_clearance")),
    )
    result = await ChatService.completions(
        model="grok-3",
        messages=[{"role": "user", "content": "请只回复 OK"}],
        stream=False,
    )
    text = str(result)
    print("result preview", text[:800])
    ok = "OK" in text.upper() or "assistant" in text or "choices" in text
    print("RESULT", "SUCCESS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
