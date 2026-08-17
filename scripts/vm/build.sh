#!/usr/bin/env bash
# Build the VM's ext2 root filesystem.
#
# CheerpX mounts an ext2 image; this turns the Dockerfile beside it into one.
# i386 containers run natively on an x86-64 host, so no emulation is involved —
# only the image's own architecture is 32-bit.
#
# The unpack and mkfs both happen inside a container running as root. That is
# not incidental: `tar -x` as an ordinary user silently reassigns every file to
# that user, and `mkfs.ext2 -d` then bakes the wrong ownership into the image —
# so `/home/dsh` ends up unwritable by the user the VM logs in as, and the first
# `echo > file` fails with EACCES.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/../../build/vm/dsh.ext2}"
size="${VM_IMAGE_SIZE:-1200M}"
tag="dsh-webvm-rootfs"
builder="dsh-webvm-builder"

outDir="$(cd "$(dirname "$out")" 2>/dev/null && pwd || (mkdir -p "$(dirname "$out")" && cd "$(dirname "$out")" && pwd))"
outName="$(basename "$out")"

echo "==> building $tag (linux/386)"
docker build --platform linux/386 -t "$tag" "$here"

echo "==> exporting the root filesystem"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
container="$(docker create --platform linux/386 "$tag")"
docker export "$container" > "$staging/rootfs.tar"
docker rm "$container" >/dev/null

echo "==> preparing the image builder"
docker build -q -t "$builder" - <<'DOCKERFILE' >/dev/null
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends e2fsprogs \
    && rm -rf /var/lib/apt/lists/*
DOCKERFILE

echo "==> writing $out ($size)"
rm -f "$out"
docker run --rm \
  -v "$staging:/staging" \
  -v "$outDir:/out" \
  -e "SIZE=$size" -e "OUT=$outName" \
  "$builder" bash -eu -c '
    mkdir -p /rootfs
    tar -x --same-owner --numeric-owner -C /rootfs -f /staging/rootfs.tar
    # `docker export` omits these, and a Linux userspace expects them present.
    mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/tmp /rootfs/run
    chmod 1777 /rootfs/tmp
    mkfs.ext2 -b 4096 -d /rootfs -F "/out/$OUT" "$SIZE" >/dev/null
  '

echo "==> done: $(du -h "$out" | cut -f1)"
