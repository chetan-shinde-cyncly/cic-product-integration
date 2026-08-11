#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="dev"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENVIRONMENT="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./deploy.sh [--env dev|prod]"
      exit 1
      ;;
  esac
done

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Unsupported environment: $ENVIRONMENT"
  exit 1
fi

CONFIG_FILE="./deployment/config/$ENVIRONMENT.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config file not found: $CONFIG_FILE"
  exit 1
fi

STACK_PREFIX=$(jq -r '.stackPrefix' "$CONFIG_FILE")
REGION=$(jq -r '.region' "$CONFIG_FILE")
DOMAIN_NAME=$(jq -r '.domainName' "$CONFIG_FILE")
NODE_ENV=$(jq -r '.nodeEnv' "$CONFIG_FILE")

echo "Deploying CIC frontend to $ENVIRONMENT ($REGION)."
npm ci
NODE_ENV="$NODE_ENV" npm run build

pushd deployment >/dev/null
npm ci
npx cdk deploy --all --require-approval never --context env="$ENVIRONMENT"
popd >/dev/null

DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}Stack" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CFID'].OutputValue" \
  --output text)

if [[ -n "$DISTRIBUTION_ID" && "$DISTRIBUTION_ID" != "None" ]]; then
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
fi

echo "Frontend deployment complete: https://$DOMAIN_NAME"
