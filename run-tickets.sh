#!/usr/bin/env bash
set -euo pipefail

tmp_dir=$(mktemp -d)
log_dir="$tmp_dir/logs"
mkdir -p "$log_dir"

cleanup() {
  rm -rf $tmp_dir

  local exit_code=$1
  local previous_command=$BASH_COMMAND
  [[ $exit_code -ne 0 ]] && [[ ! $previous_command =~ exit* ]] && echo "INFO: Script exited with code $exit_code from command $previous_command"
  exit $exit_code
}
trap 'cleanup $?' EXIT

for run in {1..10}; do
  logfile="$log_dir/run-$(printf '%03d' $run).log"
  echo "=== Run $run | log: $logfile ==="
  cc-jstream --color --logfile "$logfile" claude -p "@PROMPT-ONE-SHOT.md"
done
