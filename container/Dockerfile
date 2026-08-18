# syntax=docker/dockerfile:1

# The machine the harness runs on.
#
# `dsh` on a laptop runs in a Linux userland: bash, coreutils, git, an
# interpreter or two. This is that userland, built to be converted to WASM by
# container2wasm and executed in the tab. It is a real Debian — not something
# that imitates one — so the shell is the real bash, `git status` is real git,
# and `python3 -c` runs CPython.
#
# The toolchain follows what the devcontainer features install, because that is
# the environment people mean when they say "a dev container":
#
# - `ghcr.io/devcontainers/features/git`     → Debian's git
# - `ghcr.io/devcontainers/features/python`  → CPython 3, with pip in a venv
#                                              that is first on PATH
# - `ghcr.io/devcontainers/features/node`    → the Node LTS tarball from
#                                              nodejs.org, unpacked into
#                                              /usr/local, with npm and npx
#
# Size is the one thing this file optimizes for that a devcontainer does not.
# Every byte here is packed into the .wasm the browser downloads, so the Node
# binary is stripped, docs and locales are dropped, and nothing is installed
# with `--install-recommends`.

# The Node LTS line, as `devcontainers/features/node:1` with `version: lts`
# resolves it.
ARG NODE_VERSION=24.19.0

FROM debian:stable-slim AS node
ARG NODE_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends binutils ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
# Stripped because Node ships ~18 MB of symbols that only a debugger reads, and
# this binary is downloaded by every visitor.
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && mkdir -p /opt/node \
 && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
 && rm -f /tmp/node.tar.xz /opt/node/CHANGELOG.md /opt/node/README.md /opt/node/LICENSE \
 && rm -rf /opt/node/include /opt/node/share \
 && strip --strip-all /opt/node/bin/node

FROM debian:stable-slim
ENV DEBIAN_FRONTEND=noninteractive

# `ripgrep` is not a convenience: dsh's `grep` and `glob` tools spawn the
# ripgrep binary `@vscode/ripgrep` names and parse its output, so without it
# both tools fail on every call.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      less \
      procps \
      python3 \
      python3-venv \
      ripgrep \
      unzip \
      xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 # Reclaimed from the packed image: documentation nobody reads through a
 # terminal in a browser tab, locales for languages the page does not set, and
 # character-set converters beyond the UTF-8 the tty speaks.
 && rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/locale \
           /usr/share/lintian /usr/share/gitweb /usr/share/bash-completion \
           /usr/lib/x86_64-linux-gnu/gconv \
           /usr/lib/python3*/test /usr/lib/python3*/idlelib \
 && find /usr/lib/python3* -name '__pycache__' -type d -prune -exec rm -rf {} +

COPY --from=node /opt/node/ /usr/local/

# Debian marks its system Python as externally managed, so `pip install` into
# it refuses (PEP 668) — which is the right call on a machine and useless in a
# throwaway container. A virtualenv first on PATH gives `python3` and `pip` the
# behaviour people expect from a dev container, without disabling the guard.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV" \
 && "$VIRTUAL_ENV/bin/pip" install --no-cache-dir --upgrade pip \
 && find "$VIRTUAL_ENV" -name '__pycache__' -type d -prune -exec rm -rf {} +

# `ENV PATH` is not enough: `/etc/profile` overwrites PATH outright, and dsh
# spawns its commands through a login shell (`bash -lc --`). Without this the
# venv is on PATH for `docker run` and missing for every tool call.
RUN printf '%s\n' 'PATH="/opt/venv/bin:/usr/local/bin:$PATH"' 'export PATH' \
    > /etc/profile.d/10-dsh-path.sh

# The home the page already reports through `os.homedir()`, and the workspace
# directory the harness is configured with. The container runs as root — there
# is one user in a tab, and the workspace arrives over 9p with no uid to map.
ENV HOME=/home/dsh \
    LANG=C.UTF-8 \
    PATH=/opt/venv/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin \
    PAGER=cat \
    GIT_PAGER=cat \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
RUN mkdir -p /home/dsh/workspace \
 && git config --system --add safe.directory '*' \
 && git config --system init.defaultBranch main \
 # A placeholder identity, because there is no account to take one from and
 # `git commit` refuses without one — which on a machine is a prompt to run one
 # command and here is a dead end in the middle of an agent's work. Overridden
 # by `git config --global user.name`, as it would be anywhere else.
 && git config --system user.name dsh \
 && git config --system user.email dsh@localhost

# The machine's front door and its file service. See the headers of each: the
# container reaches the page through one byte stream, and these are what turn
# that stream into a terminal, a command runner, and a filesystem at once.
COPY container/dsh-mux container/dsh-fsd /usr/local/libexec/
RUN chmod 0755 /usr/local/libexec/dsh-mux /usr/local/libexec/dsh-fsd

WORKDIR /home/dsh/workspace

CMD ["/usr/local/libexec/dsh-mux"]
