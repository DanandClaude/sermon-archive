"""Chooses the analyzer named in the worker's settings."""

from __future__ import annotations

from .analysis import Analyzer, FakeAnalyzer
from .config import Config


def make_analyzer(config: Config) -> Analyzer:
    if config.analyzer == "fake":
        return FakeAnalyzer()
    from .anthropic_analyzer import AnthropicAnalyzer

    return AnthropicAnalyzer(config.anthropic_api_key, config.anthropic_model)
