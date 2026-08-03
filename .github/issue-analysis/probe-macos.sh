#!/usr/bin/env bash
set -euo pipefail

sw_vers
uname -a
printf 'architecture=%s\n' "$(uname -m)"
printf 'sandbox-exec=%s\n' "$(command -v sandbox-exec || true)"
printf 'docker=%s\n' "$(command -v docker || true)"
printf 'qemu-system-aarch64=%s\n' "$(command -v qemu-system-aarch64 || true)"
printf 'qemu-system-x86_64=%s\n' "$(command -v qemu-system-x86_64 || true)"
sysctl kern.hv_support 2>/dev/null || true

if ! command -v sandbox-exec >/dev/null 2>&1; then
	echo "sandbox-exec is unavailable" >&2
	exit 1
fi

probe_dir="$(mktemp -d)"
host_sentinel="$(mktemp)"
profile="$probe_dir/probe.sb"
trap 'rm -rf "$probe_dir" "$host_sentinel"' EXIT
printf 'workspace-visible\n' > "$probe_dir/visible.txt"
printf 'host-inaccessible\n' > "$host_sentinel"

cat > "$profile" <<EOF
(version 1)
(allow default)
(deny file-read* (literal "$host_sentinel"))
(deny network*)
EOF

sandbox-exec -f "$profile" /bin/cat "$probe_dir/visible.txt"
if sandbox-exec -f "$profile" /bin/cat "$host_sentinel"; then
	echo "sandbox-exec allowed the denied host sentinel" >&2
	exit 1
else
	echo "sandbox-exec denied the host sentinel"
fi

if sandbox-exec -f "$profile" /usr/bin/curl --connect-timeout 3 --max-time 5 https://api.github.com/ >/dev/null; then
	echo "sandbox-exec allowed denied network access" >&2
	exit 1
else
	echo "sandbox-exec denied outbound network access"
fi
