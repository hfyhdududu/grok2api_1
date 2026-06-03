"""
Statsig ID generator for reverse interfaces.
"""

import base64
import random
import string

from app.core.logger import logger
from app.core.config import get_config
from app.services.reverse.browser_bridge import get_browser_session


class StatsigGenerator:
    """Statsig ID generator for reverse interfaces."""

    @staticmethod
    def _rand(length: int, alphanumeric: bool = False) -> str:
        """Generate random string."""
        chars = (
            string.ascii_lowercase + string.digits
            if alphanumeric
            else string.ascii_lowercase
        )
        return "".join(random.choices(chars, k=length))

    @staticmethod
    def gen_id(token: str | None = None) -> str:
        """
        Generate Statsig ID.

        Returns:
            Base64 encoded ID.
        """
        if token:
            session = get_browser_session(token)
            session_statsig = str(session.get("x_statsig_id") or "").strip()
            if session_statsig:
                logger.debug("Using browser session Statsig ID")
                return session_statsig

        dynamic = get_config("app.dynamic_statsig")

        # Dynamic Statsig ID
        if dynamic:
            logger.debug("Generating dynamic Statsig ID")

            if random.choice([True, False]):
                rand = StatsigGenerator._rand(5, alphanumeric=True)
                message = (
                    f"x1:TypeError: Cannot read properties of null "
                    f"(reading 'children[\\'{rand}\\']')"
                )
            else:
                rand = StatsigGenerator._rand(10)
                message = (
                    f"x1:TypeError: Cannot read properties of undefined (reading '{rand}')"
                )

            return base64.b64encode(message.encode()).decode()

        # Static Statsig ID
        logger.debug("Generating static Statsig ID")
        return "ZTpUeXBlRXJyb3I6IENhbm5vdCByZWFkIHByb3BlcnRpZXMgb2YgdW5kZWZpbmVkIChyZWFkaW5nICdjaGlsZE5vZGVzJyk="


__all__ = ["StatsigGenerator"]
