"""使用项目配置 + 纯算法 statsig 做直连会话测试。"""
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.core.config import config, register_defaults
from app.services.grok.defaults import get_grok_defaults
from app.services.reverse.app_chat import AppChatReverse
from app.services.reverse.utils.statsig_pure import generate, verify_structure
from app.services.token.manager import get_token_manager
from curl_cffi.requests import AsyncSession


async def main() -> int:
    register_defaults(get_grok_defaults())
    await config.load()

    sg = generate("/rest/app-chat/conversations/new", "POST")
    ok, msg = verify_structure(sg)
    print("pure statsig len", len(sg), "ok", ok, msg)

    mgr = await get_token_manager()
    token = None
    for pool in ("ssoBasic", "ssoSuper", "ssoHeavy"):
        token = mgr.get_token(pool)
        if token:
            print("using pool", pool)
            break
    if not token:
        print("no token")
        return 1

    async with AsyncSession() as session:
        stream = await AppChatReverse.request(
            session,
            token,
            message="纯算法 statsig 测试，请只回复 OK",
            model="grok-3",
            requested_model="grok-3",
            minimal_payload=True,
        )
        chunks = []
        async for line in stream:
            chunks.append(line)
            if len(chunks) > 30:
                break
        preview = "".join(chunks)[:1500]
        print("stream preview:", preview)
        success = any(
            x in preview.lower()
            for x in ("data:", "ok", "assistant", "message")
        ) and "403" not in preview and "anti-bot" not in preview.lower()
        print("RESULT", "SUCCESS" if success else "FAILED")
        return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
