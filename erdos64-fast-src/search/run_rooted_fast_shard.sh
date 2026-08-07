#!/usr/bin/env bash
# Exact rooted-block shard: canonical geng -> validated C8 witness prefilter ->
# retained survivor stream -> independent dual-algorithm Python fallback.

set -Eeuo pipefail
umask 077
export LC_ALL=C PYTHONHASHSEED=0

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
PYTHON=${PYTHON:-python3}
CC=${CC:-cc}
GENG_BIN=${GENG_BIN:-}
SOURCE_REPOSITORY=${SOURCE_REPOSITORY:-rtl-ai/erdos-64-power2-cycle-lab}
SOURCE_COMMIT=${SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo UNAVAILABLE)}
ORDER=17
MIN_EDGES=25
MAX_EDGES=38
MAX_DEGREE=8

usage() {
  echo "Usage: $0 RESIDUE MODULUS OUTPUT_DIR" >&2
  exit 64
}

sha256_file() {
  "$PYTHON" - "$1" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
hash_value = hashlib.sha256()
with path.open("rb") as stream:
    for block in iter(lambda: stream.read(1 << 20), b""):
        hash_value.update(block)
print(hash_value.hexdigest())
PY
}

write_manifest() {
  "$PYTHON" - "$1" <<'PY'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
lines = []
for path in sorted(root.iterdir(), key=lambda item: item.name):
    if not path.is_file() or path.name == "SHA256SUMS.txt":
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f"{digest}  {path.name}")
(root / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n")
PY
}

[[ $# -eq 3 ]] || usage
RESIDUE=$1
MODULUS=$2
OUT_DIR=$3
[[ $RESIDUE =~ ^[0-9]+$ && $MODULUS =~ ^[1-9][0-9]*$ ]] || usage
(( RESIDUE < MODULUS )) || usage

if [[ -n $GENG_BIN ]]; then
  GENG=$(command -v "$GENG_BIN")
elif command -v geng >/dev/null 2>&1; then
  GENG=$(command -v geng)
elif command -v nauty-geng >/dev/null 2>&1; then
  GENG=$(command -v nauty-geng)
else
  echo "geng/nauty-geng not found" >&2
  exit 69
fi

PREFILTER_SOURCE="$SCRIPT_DIR/rooted_prefilter.c"
PREFILTER="$OUT_DIR/rooted_prefilter"
CHECKER="$SCRIPT_DIR/rooted_block_exact.py"
BOUNDS="$SCRIPT_DIR/rooted_bounds.py"
COMBINER="$SCRIPT_DIR/combine_rooted_fast_summary.py"
mkdir -p "$OUT_DIR"

set +e
"$CC" -std=c17 -O3 -Wall -Wextra -Wpedantic -Werror \
  "$PREFILTER_SOURCE" -o "$PREFILTER" \
  >"$OUT_DIR/compile.stdout" 2>"$OUT_DIR/compile.stderr"
COMPILE_RC=$?
set -e
if (( COMPILE_RC != 0 )); then
  printf 'compile_exit_code=%s\n' "$COMPILE_RC" > "$OUT_DIR/RUN.txt"
  write_manifest "$OUT_DIR"
  exit "$COMPILE_RC"
fi

set +e
"$PYTHON" "$BOUNDS" "$ORDER" \
  --expect-min-edges "$MIN_EDGES" \
  --expect-max-edges "$MAX_EDGES" \
  --expect-max-degree "$MAX_DEGREE" \
  >"$OUT_DIR/bounds.json" 2>"$OUT_DIR/bounds.stderr"
BOUNDS_RC=$?
set -e
if (( BOUNDS_RC != 0 )); then
  {
    printf 'compile_exit_code=%s\n' "$COMPILE_RC"
    printf 'bounds_exit_code=%s\n' "$BOUNDS_RC"
  } > "$OUT_DIR/RUN.txt"
  write_manifest "$OUT_DIR"
  exit "$BOUNDS_RC"
fi

COMMAND="$GENG -C -q -d2 -f -D$MAX_DEGREE $ORDER $MIN_EDGES:$MAX_EDGES $RESIDUE/$MODULUS"
printf '%s\n' "$COMMAND" > "$OUT_DIR/COMMAND.txt"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_EPOCH=$(date +%s)

set +e
"$GENG" -C -q -d2 -f -D"$MAX_DEGREE" "$ORDER" \
  "$MIN_EDGES:$MAX_EDGES" "$RESIDUE/$MODULUS" \
  2>"$OUT_DIR/geng.stderr" \
  | "$PREFILTER" --order "$ORDER" --summary "$OUT_DIR/prefilter-summary.json" \
      2>"$OUT_DIR/prefilter.stderr" \
  | tee "$OUT_DIR/survivors.g6" \
  | "$PYTHON" "$CHECKER" --order "$ORDER" --require-c4-free \
      --candidates "$OUT_DIR/candidates.jsonl" \
      --summary "$OUT_DIR/exact-summary.json" \
      >"$OUT_DIR/checker.stdout" 2>"$OUT_DIR/checker.stderr"
PIPELINE=("${PIPESTATUS[@]}")
set -e
GENG_RC=${PIPELINE[0]}
PREFILTER_RC=${PIPELINE[1]}
TEE_RC=${PIPELINE[2]}
CHECKER_RC=${PIPELINE[3]}

set +e
"$PYTHON" "$COMBINER" \
  --prefilter "$OUT_DIR/prefilter-summary.json" \
  --exact "$OUT_DIR/exact-summary.json" \
  --output "$OUT_DIR/combined-summary.json" \
  >"$OUT_DIR/combiner.stdout" 2>"$OUT_DIR/combiner.stderr"
COMBINER_RC=$?
set -e

FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FINISH_EPOCH=$(date +%s)
RC=0
for value in "$COMPILE_RC" "$BOUNDS_RC" "$GENG_RC" "$PREFILTER_RC" \
  "$TEE_RC" "$CHECKER_RC" "$COMBINER_RC"; do
  (( value == 0 )) || RC=1
done

CANDIDATE_COUNT=-1
SURVIVOR_COUNT=-1
if [[ -f "$OUT_DIR/candidates.jsonl" ]]; then
  CANDIDATE_COUNT=$(wc -l < "$OUT_DIR/candidates.jsonl" | tr -d ' ')
fi
if [[ -f "$OUT_DIR/survivors.g6" ]]; then
  SURVIVOR_COUNT=$(wc -l < "$OUT_DIR/survivors.g6" | tr -d ' ')
fi

{
  printf 'source_repository=%s\n' "$SOURCE_REPOSITORY"
  printf 'source_commit=%s\n' "$SOURCE_COMMIT"
  printf 'rooted_block_exact_sha256=%s\n' "$(sha256_file "$CHECKER")"
  printf 'rooted_prefilter_source_sha256=%s\n' "$(sha256_file "$PREFILTER_SOURCE")"
  printf 'rooted_prefilter_binary_sha256=%s\n' "$(sha256_file "$PREFILTER")"
  printf 'rooted_bounds_sha256=%s\n' "$(sha256_file "$BOUNDS")"
  printf 'combiner_sha256=%s\n' "$(sha256_file "$COMBINER")"
  printf 'order=%s\n' "$ORDER"
  printf 'residue=%s\n' "$RESIDUE"
  printf 'modulus=%s\n' "$MODULUS"
  printf 'started_utc=%s\n' "$STARTED"
  printf 'finished_utc=%s\n' "$FINISHED"
  printf 'elapsed_seconds=%s\n' "$((FINISH_EPOCH - START_EPOCH))"
  printf 'compile_exit_code=%s\n' "$COMPILE_RC"
  printf 'bounds_exit_code=%s\n' "$BOUNDS_RC"
  printf 'geng_exit_code=%s\n' "$GENG_RC"
  printf 'prefilter_exit_code=%s\n' "$PREFILTER_RC"
  printf 'tee_exit_code=%s\n' "$TEE_RC"
  printf 'checker_exit_code=%s\n' "$CHECKER_RC"
  printf 'combiner_exit_code=%s\n' "$COMBINER_RC"
  printf 'pipeline_exit_code=%s\n' "$RC"
  printf 'survivor_count=%s\n' "$SURVIVOR_COUNT"
  printf 'candidate_count=%s\n' "$CANDIDATE_COUNT"
  if [[ -f "$OUT_DIR/survivors.g6" ]]; then
    printf 'survivor_sha256=%s\n' "$(sha256_file "$OUT_DIR/survivors.g6")"
  fi
  if [[ -f "$OUT_DIR/candidates.jsonl" ]]; then
    printf 'candidate_sha256=%s\n' "$(sha256_file "$OUT_DIR/candidates.jsonl")"
  fi
  if [[ -f "$OUT_DIR/combined-summary.json" ]]; then
    printf 'combined_summary_sha256=%s\n' "$(sha256_file "$OUT_DIR/combined-summary.json")"
  fi
} > "$OUT_DIR/RUN.txt"

write_manifest "$OUT_DIR"

if [[ -f "$OUT_DIR/combined-summary.json" ]]; then
  cat "$OUT_DIR/combined-summary.json"
fi
cat "$OUT_DIR/RUN.txt"
exit "$RC"
