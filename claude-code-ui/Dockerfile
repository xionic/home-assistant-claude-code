ARG BUILD_FROM
FROM ${BUILD_FROM}

# Install system packages
# Note: no ttyd or tmux — claudecodeui provides the web UI and embedded terminal
RUN apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    nano \
    nodejs \
    npm \
    python3 \
    py3-pip \
    py3-requests \
    py3-aiohttp \
    py3-yaml \
    py3-beautifulsoup4 \
    tree \
    uv \
    vim \
    wget

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@latest \
    && npm cache clean --force

# Install claudecodeui server (pre-built npm package)
# This provides the mobile-friendly web UI that wraps Claude Code
# Source: https://github.com/siteboon/claudecodeui (AGPL-3.0)
RUN npm install -g @cloudcli-ai/cloudcli@latest \
    && npm cache clean --force

# HA config directory is the default working directory
RUN mkdir -p /config/claude-config
WORKDIR /config

# Copy startup script and modular helper scripts
COPY run.sh /run.sh
COPY scripts/ /opt/scripts/
RUN chmod +x /run.sh \
    && chmod +x /opt/scripts/*.sh

CMD ["/run.sh"]
