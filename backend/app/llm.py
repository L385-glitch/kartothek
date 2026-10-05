"""Thin OpenAI-compatible chat client with retries and JSON extraction.

No external SDK needed — just urllib against /v1/chat/completions.
Works with llama.cpp, vLLM, Ollama, LM Studio, or any compatible server.
"""
from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.request
from typing import Any

from .config import settings

log = logging.getLogger("studydeck.llm")


class LLMError(Exception):
    pass


class LLMClient:
    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = (base_url or settings.llm_base_url).rstrip("/")
        if not self.base_url.endswith("/v1"):
            self.base_url += "/v1"
        self.api_key = api_key or settings.llm_api_key

    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int = 8000,
        timeout: int | None = None,
    ) -> str:
        """Single chat completion, returning the assistant text.

        Retries with exponential backoff on network errors / 5xx / 429.
        """
        model = model or settings.llm_model
        timeout = timeout or settings.llm_timeout_s
        payload = {
            "model": model,
            "messages": messages,
            "temperature": settings.llm_temperature if temperature is None else temperature,
            "max_tokens": max_tokens,
        }
        data = json.dumps(payload).encode()
        url = f"{self.base_url}/chat/completions"

        last_err: Exception | None = None
        for attempt in range(1, settings.llm_max_retries + 1):
            req = urllib.request.Request(
                url, data=data,
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {self.api_key}"},
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    body = json.load(resp)
                content = body["choices"][0]["message"]["content"]
                if not content:
                    raise LLMError("empty completion")
                return content
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                    ConnectionError, json.JSONDecodeError, KeyError, LLMError) as e:
                last_err = e
                # 4xx (except 429) is not retryable
                if isinstance(e, urllib.error.HTTPError) and e.code < 500 and e.code != 429:
                    raise LLMError(f"LLM HTTP {e.code}: {e.read()[:300]}") from e
                wait = min(2 ** attempt, 30)
                log.warning("LLM call failed (attempt %d/%d): %s — retrying in %ds",
                            attempt, settings.llm_max_retries, e, wait)
                time.sleep(wait)
        raise LLMError(f"LLM call failed after {settings.llm_max_retries} attempts: {last_err}")

    def chat_json(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int = 8000,
        retries: int = 2,
    ) -> Any:
        """Chat completion that must return JSON. Parses it, retrying the
        whole call if the model returns malformed JSON."""
        last_text = ""
        for i in range(retries + 1):
            text = self.chat(messages, model=model, temperature=temperature, max_tokens=max_tokens)
            last_text = text
            try:
                return extract_json(text)
            except json.JSONDecodeError as e:
                if i < retries:
                    log.warning("LLM returned non-JSON (%s); retrying. tail=%r", e, text[-200:])
                    # Nudge the model back on track.
                    messages = messages + [
                        {"role": "assistant", "content": text},
                        {"role": "user",
                         "content": "Deine Antwort war kein gültiges JSON. Antworte NUR mit dem gültigen JSON-Objekt, ohne Erklärungen und ohne Markdown."},
                    ]
        raise LLMError(f"LLM never returned valid JSON. Last: {last_text[:400]}")


def extract_json(text: str) -> Any:
    """Pull a JSON object/array out of a model response.

    Handles: bare JSON, ```json fences, leading prose, trailing prose.
    """
    text = text.strip()
    # Strip code fences
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    # Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Find the outermost balanced {...} or [...]
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        if start == -1:
            continue
        depth = 0
        for i in range(start, len(text)):
            if text[i] == opener:
                depth += 1
            elif text[i] == closer:
                depth -= 1
                if depth == 0:
                    candidate = text[start:i + 1]
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        break
    raise json.JSONDecodeError("no JSON found in response", text, 0)
