# Login environment for the harness VM.
#
# The busybox applet links come last so a Debian coreutil always wins the name;
# busybox is the fallback that makes the rest of its applets reachable.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/busybox-links"
export TERM="${TERM:-xterm-256color}"
export LANG="${LANG:-C.UTF-8}"
export PAGER=cat
export EDITOR="${EDITOR:-nano}"
