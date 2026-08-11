#!/usr/bin/env bash
set -euo pipefail

echo "You are deploying the CIC backend to production."
read -r -p "Type yes to continue: " REPLY
if [[ ! "$REPLY" =~ ^[Yy][Ee][Ss]$ ]]; then
  echo "Deployment cancelled."
  exit 1
fi

./deploy.sh --env prod
