#!/usr/bin/env bash
set -euo pipefail

SOURCE=""
BUCKET=""
PREFIX="catalogs"
REGION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --bucket) BUCKET="${2:-}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SOURCE" || -z "$BUCKET" ]]; then
  echo "Usage: $0 --source /mounted/efs/catalogs --bucket BUCKET [--prefix catalogs] [--region REGION]" >&2
  exit 1
fi

if [[ ! -d "$SOURCE" ]]; then
  echo "Source directory does not exist: $SOURCE" >&2
  exit 1
fi

DESTINATION="s3://${BUCKET}/${PREFIX#/}"
DESTINATION="${DESTINATION%/}/"
AWS_ARGS=()
if [[ -n "$REGION" ]]; then
  AWS_ARGS+=(--region "$REGION")
fi

echo "Copying catalog files from $SOURCE to $DESTINATION"
aws s3 sync "$SOURCE/" "$DESTINATION" "${AWS_ARGS[@]}" --only-show-errors

LOCAL_COUNT=$(find "$SOURCE" -type f | wc -l | tr -d ' ')
REMOTE_COUNT=$(aws s3 ls "$DESTINATION" --recursive "${AWS_ARGS[@]}" | wc -l | tr -d ' ')
if [[ "$LOCAL_COUNT" != "$REMOTE_COUNT" ]]; then
  echo "Migration verification failed: local=$LOCAL_COUNT remote=$REMOTE_COUNT" >&2
  exit 1
fi

echo "Migration verified: $REMOTE_COUNT files are present in S3."
