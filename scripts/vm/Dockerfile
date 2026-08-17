# The VM's root filesystem.
#
# CheerpX executes 32-bit x86 only, so this is an i386 Debian — which is also
# why it cannot simply be `mcr.microsoft.com/devcontainers/universal`: that
# image is amd64-only and roughly 12 GB expanded, against CheerpX's 2 GB ext2
# ceiling and a static host's own size budget.
#
# The base is **bullseye**, not the current stable, and that is load-bearing.
# On bookworm (glibc 2.36) a program that initialises a language runtime prints
# its output and then hangs forever in exit: `python3 -c 'print(1)'` emits `1`
# and never returns, while `os._exit(0)` returns immediately, so the hang is in
# interpreter finalisation — glibc's thread-teardown path uses syscalls this
# kernel emulation does not answer. glibc 2.31 exits cleanly. It is not a
# preference for older software; it is the difference between a machine that
# works and one where every second command wedges the shell.
FROM i386/debian:bullseye

ENV DEBIAN_FRONTEND=noninteractive

# Debian's own command line, in full. A shell script written anywhere else
# assumes these exist, so a missing one does not degrade a pipeline — it stops
# it at the first line that uses one. `busybox` is here as well because its
# applet set is not the same set as coreutils'.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash dash busybox \
      coreutils findutils diffutils grep sed gawk mawk \
      bsdmainutils util-linux procps psmisc lsof \
      file less moreutils nano vim-tiny \
      tar gzip bzip2 xz-utils zip unzip zstd cpio \
      ca-certificates curl wget openssl rsync \
      git git-lfs openssh-client patch \
      ripgrep fd-find jq sqlite3 tree ncdu \
      bash-completion locales tzdata \
      iproute2 iputils-ping netcat-openbsd dnsutils \
    && rm -rf /var/lib/apt/lists/*

# Python, and the compiler toolchain that completes it: without a compiler,
# `pip install` of anything carrying a C extension fails at the last step.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python3-dev \
      build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Node, from the 32-bit builds the project publishes outside its main release
# matrix — Debian 11 ships Node 12, which is too old to install much of npm.
#
# 16 is the ceiling rather than the choice: 18 and 20 abort at startup with
# V8's "Check failed: VerifyChecksum" while unpacking their startup snapshot,
# because the CPU this engine presents is not the one those builds assume.
ARG NODE_VERSION=16.20.2
RUN curl -fsSL "https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x86.tar.xz" \
      -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && /usr/local/bin/node --version

# The user the harness runs as, on the paths the host already uses so a
# workspace path means the same thing on both sides.
RUN useradd -m -u 1000 -s /bin/bash dsh \
    && mkdir -p /home/dsh/workspace \
    && chown -R dsh:dsh /home/dsh

# `busybox` ships its applets as one binary; linking them makes `ash`, `vi`, and
# the rest resolvable by name the way a busybox system presents them. They sit
# last on `PATH`, so a Debian tool always wins the name.
RUN mkdir -p /usr/lib/busybox-links \
    && busybox --install -s /usr/lib/busybox-links 2>/dev/null || true

# Documentation, manuals, and locales are a large share of the image and none of
# it is reachable from a browser tab. Removing them in the final layer is what
# makes the removal count: `docker export` flattens, so what matters is what is
# left here rather than what any one layer added.
RUN rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/locale \
      /usr/share/i18n /usr/share/help /usr/share/lintian /usr/share/bug \
      /usr/share/gtk-doc /usr/share/javascript /usr/share/icons /usr/share/fonts \
      /var/cache/apt /var/lib/apt/lists \
    && mkdir -p /usr/share/man /usr/share/doc

COPY profile.sh /etc/profile.d/dsh.sh

WORKDIR /home/dsh/workspace
