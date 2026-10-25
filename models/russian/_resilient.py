"""Resilient GigaChat transport shared by the single-shot and ReAct clients.

* two servers: the primary ``base_url`` (``https://api.giga.chat/v1``) and a
  ``fallback_base_url`` (the old ``gigachat.devices.sberbank.ru`` host) used when the
  primary cannot be reached;
* retries with exponential backoff on connection resets (WinError 10054), timeouts,
  429 and 5xx;
* a model fallback chain (``model`` then ``fallback_models``) used when a model keeps
  failing or is unavailable (404/403/400 on that model);
* every response's ``model`` field is logged and a mismatch with the requested model
  produces a warning (the server must not silently substitute another tier).

The SDK object is created per base URL, lazily, through ``gigachat.GigaChat`` so tests
can patch it. Nothing here touches the network on import.
"""

from __future__ import annotations

import logging
import random
import time
from typing import TYPE_CHECKING, Callable, Iterator

if TYPE_CHECKING:
    from core.config import ModelConfig

log = logging.getLogger("korpus.gigachat")

#: Retryable HTTP statuses (in addition to transport-level failures).
_RETRY_STATUS = (429, 500, 502, 503, 504)


def _status(exc: Exception) -> int | None:
    code = getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


def is_connection_error(exc: Exception) -> bool:
    import httpx

    return isinstance(exc, (httpx.TransportError, ConnectionError, TimeoutError, OSError))


def is_transient(exc: Exception) -> bool:
    """True for connection/timeouts/429/5xx - worth retrying the same request."""
    return is_connection_error(exc) or _status(exc) in _RETRY_STATUS


def is_auth_error(exc: Exception) -> bool:
    return _status(exc) == 401


def model_chain(mc: "ModelConfig") -> list[str]:
    chain = [mc.model]
    for m in mc.fallback_models or []:
        if m and m not in chain:
            chain.append(m)
    return chain


def base_urls(mc: "ModelConfig", model: str | None = None) -> list[str | None]:
    """Servers to try for ``model``. The old fallback host only serves the 2-series and
    plain ``GigaChat``; ``GigaChat-3-*`` exist only on the primary, so it is skipped."""
    urls: list[str | None] = [mc.base_url]
    fb = getattr(mc, "fallback_base_url", None)
    if fb and fb != mc.base_url and not (model or "").lower().startswith("gigachat-3"):
        urls.append(fb)
    return urls


def is_rate_limit(exc: Exception) -> bool:
    return _status(exc) == 429


def retry_after(exc: Exception) -> float | None:
    """Seconds from a ``Retry-After`` header on the error/its response, if any."""
    cands = [getattr(exc, "headers", None), getattr(getattr(exc, "response", None), "headers", None)]
    for h in cands:
        if not h:
            continue
        try:
            val = h.get("Retry-After") or h.get("retry-after")
            if val is not None:
                return max(0.0, float(val))
        except (AttributeError, TypeError, ValueError):
            continue
    return None


class ResilientGigaChat:
    def __init__(
        self, mc: "ModelConfig", *, sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[float], float] | None = None,
    ) -> None:
        from core.config import ConfigError

        if not mc.api_key:
            raise ConfigError(
                "GigaChat: пустой ключ авторизации (проверьте GIGACHAT_CREDENTIALS в .env)"
            )
        try:
            import gigachat  # noqa: F401
        except ImportError as exc:  # pragma: no cover - environment-dependent
            raise ConfigError(
                "Не установлен пакет gigachat. Установите его: pip install gigachat"
            ) from exc
        self._mc = mc
        self._sleep = sleep
        # jitter(delay) -> extra seconds; default up to 25% random
        self._jitter = jitter or (lambda d: random.uniform(0, d * 0.25))
        self._clients: dict[str | None, object] = {}
        self._client_for(mc.base_url)  # primary eagerly: surfaces config problems early
        self.last_model: str | None = None  # model reported by the last response

    def _client_for(self, url: str | None):
        if url not in self._clients:
            from gigachat import GigaChat

            kwargs: dict = dict(
                credentials=self._mc.api_key,
                scope=self._mc.scope or "GIGACHAT_API_PERS",
                model=self._mc.model,
                verify_ssl_certs=self._mc.verify_ssl,
            )
            if url:
                kwargs["base_url"] = url
            self._clients[url] = GigaChat(**kwargs)
        return self._clients[url]

    def _rate_delay(self, exc: Exception, n: int, waited: float) -> float | None:
        """Delay before retry ``n`` (0-based) of a 429, or None when the budget
        (attempt count / total wait cap) is exhausted."""
        mc = self._mc
        if n >= int(mc.rate_limit_retries):
            return None
        base = float(mc.rate_limit_backoff)
        cap = float(mc.rate_limit_max_wait)
        delay = retry_after(exc)
        if delay is None:
            delay = min(base * (2 ** n), cap)
        delay += self._jitter(delay)
        if waited + delay > cap:
            delay = cap - waited
            if delay <= 0:
                return None
        return delay

    def _attempts(self, call: Callable[[object, str], object]):
        """Run ``call(client, model)`` over models x urls with retries; return
        ``(result, model)`` of the first success, else raise the last error.

        429 = rate limit: wait (Retry-After or exponential backoff + jitter) and retry on
        the SAME host; never fail over to another host because of it. Connection/5xx
        failures retry briefly, then try the next host (only if it serves the model);
        any other error (e.g. 404 No such model) moves on to the next host/model."""
        mc = self._mc
        retries = max(0, int(mc.max_retries))
        backoff = float(mc.retry_backoff)
        last: Exception | None = None
        for model in model_chain(mc):
            rate_limited = False
            for url in base_urls(mc, model):
                client = self._client_for(url)
                attempt = 0
                rl = 0
                waited = 0.0
                while True:
                    try:
                        return call(client, model), model
                    except Exception as exc:  # noqa: BLE001
                        last = exc
                        if is_auth_error(exc):
                            raise
                        if is_rate_limit(exc):
                            delay = self._rate_delay(exc, rl, waited)
                            if delay is not None:
                                log.warning(
                                    "GigaChat %s @ %s: 429 (лимит запросов) - повтор %d/%d через %.1fs",
                                    model, url or "default", rl + 1, mc.rate_limit_retries, delay,
                                )
                                rl += 1
                                waited += delay
                                self._sleep(delay)
                                continue
                            rate_limited = True
                        elif is_transient(exc) and attempt < retries:
                            delay = min(backoff * (2 ** attempt), 30.0)
                            log.warning(
                                "GigaChat %s @ %s: %s - повтор %d/%d через %.1fs",
                                model, url or "default", exc.__class__.__name__,
                                attempt + 1, retries, delay,
                            )
                            attempt += 1
                            self._sleep(delay)
                            continue
                        log.warning(
                            "GigaChat %s @ %s не ответил: %s: %s",
                            model, url or "default", exc.__class__.__name__, exc,
                        )
                        break
                if rate_limited:
                    break  # 429 is not a host problem: don't try another host, next model
        assert last is not None
        raise last

    def _check_model(self, resp, requested: str) -> None:
        got = getattr(resp, "model", None)
        if not (isinstance(got, str) and got):
            self.last_model = requested
            return
        self.last_model = got
        log.info("GigaChat: запрошена %s, ответила %s", requested, got)
        # the server may append a version suffix (GigaChat-3-Ultra:32.9.23.6)
        if got.split(":")[0].lower() != requested.lower():
            log.warning("GigaChat: несовпадение модели - запрошена %s, ответила %s", requested, got)

    def chat(self, build_chat: Callable[[str], object]):
        """``build_chat(model)`` -> SDK ``Chat``. Returns the SDK response."""
        resp, model = self._attempts(lambda client, model: client.chat(build_chat(model)))
        self._check_model(resp, model)
        return resp

    def stream(self, build_chat: Callable[[str], object]) -> Iterator:
        """Stream chunks. Retry/failover only happens before the first chunk is yielded."""
        last: Exception | None = None
        for model in model_chain(self._mc):
            rate_limited = False
            for url in base_urls(self._mc, model):
                client = self._client_for(url)
                rl = 0
                waited = 0.0
                while True:
                    started = False
                    try:
                        for chunk in client.stream(build_chat(model)):
                            started = True
                            yield chunk
                        return
                    except Exception as exc:  # noqa: BLE001
                        if started or is_auth_error(exc):
                            raise
                        last = exc
                        if is_rate_limit(exc):
                            delay = self._rate_delay(exc, rl, waited)
                            if delay is not None:
                                log.warning("GigaChat stream %s @ %s: 429 - повтор через %.1fs",
                                            model, url or "default", delay)
                                rl += 1
                                waited += delay
                                self._sleep(delay)
                                continue
                            rate_limited = True
                        log.warning("GigaChat stream %s @ %s: %s", model, url or "default", exc)
                        break
                if rate_limited:
                    break
        assert last is not None
        raise last
