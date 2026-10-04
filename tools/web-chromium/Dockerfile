# Build from the repository root. Downloads happen here, never inside an E2E job.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
COPY .github/actions/apt-drop-unused-sources/drop-unused-sources.sh /opt/brainstrike/drop-unused-sources.sh
RUN bash /opt/brainstrike/drop-unused-sources.sh \
    && apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*
COPY apps/web/config/web-chromium.mjs /opt/brainstrike/apps/web/config/web-chromium.mjs
COPY scripts/provision-web-chromium.mjs /opt/brainstrike/scripts/provision-web-chromium.mjs
RUN node /opt/brainstrike/scripts/provision-web-chromium.mjs /opt/brainstrike/web-chromium
ENV BRAINSTRIKE_WEB_CHROMIUM_DIR=/opt/brainstrike/web-chromium
USER 1001
