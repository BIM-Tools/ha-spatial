# Linux dev/test image. Home Assistant Core only supports Linux and requires
# Python >= 3.14.2 as of 2026.10, so tests run here rather than on the host.
FROM mcr.microsoft.com/devcontainers/python:3.14

RUN pip install --no-cache-dir uv

# Install test deps in their own layer so source edits don't trigger a reinstall.
COPY requirements_test.txt /tmp/requirements_test.txt
RUN uv pip install --system --no-cache -r /tmp/requirements_test.txt

WORKDIR /workspaces/ha-spatial
