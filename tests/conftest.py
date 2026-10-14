"""Lets Home Assistant load the custom integration in every test."""

import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Allow Home Assistant to load custom_components/spatial in every test."""
    yield
