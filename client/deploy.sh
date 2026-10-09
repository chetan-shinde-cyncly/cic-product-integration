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
NODE_ENV=$(jq -r '.nodeEnv' "$CONFIG_FILE")
ACCOUNT=$(jq -r '.account' "$CONFIG_FILE")
EXPECTED_DISTRIBUTION_ID=$(jq -r '.expectedDistributionId // empty' "$CONFIG_FILE")
EXPECTED_API_ORIGIN=$(jq -r '.expectedApiOrigin // empty' "$CONFIG_FILE")
STACK_NAME="${STACK_PREFIX}Stack"

# Pre-flight: make sure we are about to update the existing distribution that
# serves the custom domain, not create or replace one.
CALLER_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [[ "$CALLER_ACCOUNT" != "$ACCOUNT" ]]; then
  echo "AWS credentials are for account $CALLER_ACCOUNT, expected $ACCOUNT." >&2
  exit 1
fi

if [[ -n "$EXPECTED_DISTRIBUTION_ID" ]]; then
  STACK_DISTRIBUTION_ID=$(aws cloudformation list-stack-resources \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::CloudFront::Distribution'].PhysicalResourceId | [0]" \
    --output text)
  if [[ "$STACK_DISTRIBUTION_ID" != "$EXPECTED_DISTRIBUTION_ID" ]]; then
    echo "Stack $STACK_NAME manages distribution '$STACK_DISTRIBUTION_ID'," >&2
    echo "but $CONFIG_FILE expects '$EXPECTED_DISTRIBUTION_ID'. Aborting." >&2
    exit 1
  fi
fi

if [[ -n "$EXPECTED_API_ORIGIN" ]]; then
  API_EXPORT_NAME=$([[ "$NODE_ENV" == "production" ]] && echo "CicApiAlbDnsProduction" || echo "CicApiAlbDns")
  API_EXPORT_VALUE=$(aws cloudformation list-exports \
    --region "$REGION" \
    --query "Exports[?Name=='$API_EXPORT_NAME'].Value | [0]" \
    --output text)
  if [[ "${API_EXPORT_VALUE,,}" != "${EXPECTED_API_ORIGIN,,}" ]]; then
    echo "Export $API_EXPORT_NAME is '$API_EXPORT_VALUE', expected '$EXPECTED_API_ORIGIN'. Aborting." >&2
    exit 1
  fi
fi

echo "Deploying CIC frontend to $ENVIRONMENT ($REGION)."
npm ci
NODE_ENV="$NODE_ENV" npm run build

OUTPUTS_FILE=$(mktemp "${TMPDIR:-/tmp}/cic-cdk-outputs.XXXXXX")
DIFF_FILE=$(mktemp "${TMPDIR:-/tmp}/cic-cdk-diff.XXXXXX")
trap 'rm -f "$OUTPUTS_FILE" "$DIFF_FILE"' EXIT

pushd deployment >/dev/null
npm ci

# Refuse to deploy if CloudFormation would delete or replace anything (the
# distribution, bucket, OAI or bucket policy). A normal release only changes
# the BucketDeployment asset.
npx cdk diff "$STACK_NAME" --no-color --context env="$ENVIRONMENT" 2>&1 | tee "$DIFF_FILE"
if grep -qE '^\[-\]|replace' "$DIFF_FILE"; then
  echo "cdk diff shows a resource removal or replacement. Aborting; review the diff above." >&2
  exit 1
fi
if grep -qE '^\[~\] AWS::CloudFront::Distribution' "$DIFF_FILE"; then
  read -r -p "The diff modifies the CloudFront distribution settings. Type yes to continue: " REPLY
  if [[ ! "$REPLY" =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Deployment cancelled."
    exit 1
  fi
fi

npx cdk deploy "$STACK_NAME" --exclusively --require-approval never \
  --context env="$ENVIRONMENT" --outputs-file "$OUTPUTS_FILE"
popd >/dev/null

DISTRIBUTION_ID=$(jq -r --arg stack "$STACK_NAME" \
  '.[$stack].CFID // empty' "$OUTPUTS_FILE")
CLOUDFRONT_URL=$(jq -r --arg stack "$STACK_NAME" \
  '.[$stack].CloudFrontURL // empty' "$OUTPUTS_FILE")

if [[ -z "$DISTRIBUTION_ID" || "$DISTRIBUTION_ID" == "None" ]]; then
  DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='CFID'].OutputValue | [0]" \
    --output text)
fi

if [[ -z "$CLOUDFRONT_URL" || "$CLOUDFRONT_URL" == "None" ]]; then
  CLOUDFRONT_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='CloudFrontURL'].OutputValue | [0]" \
    --output text)
fi

# Stack outputs can be absent on older deployments. In that case, discover the
# CloudFront distribution from the stack resource list itself.
if [[ -z "$DISTRIBUTION_ID" || "$DISTRIBUTION_ID" == "None" ]]; then
  DISTRIBUTION_ID=$(aws cloudformation list-stack-resources \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::CloudFront::Distribution'].PhysicalResourceId | [0]" \
    --output text)
fi

if [[ -n "$DISTRIBUTION_ID" && "$DISTRIBUTION_ID" != "None" ]]; then
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
fi

if [[ -z "$CLOUDFRONT_URL" || "$CLOUDFRONT_URL" == "None" ]]; then
  if [[ -n "$DISTRIBUTION_ID" && "$DISTRIBUTION_ID" != "None" ]]; then
    CLOUDFRONT_DOMAIN=$(aws cloudfront get-distribution \
      --id "$DISTRIBUTION_ID" \
      --query "Distribution.DomainName" \
      --output text)
    if [[ -n "$CLOUDFRONT_DOMAIN" && "$CLOUDFRONT_DOMAIN" != "None" ]]; then
      CLOUDFRONT_URL="https://${CLOUDFRONT_DOMAIN}"
    fi
  fi
fi

if [[ -z "$CLOUDFRONT_URL" || "$CLOUDFRONT_URL" == "None" ]]; then
  echo "Deployment completed, but the CloudFront URL could not be resolved." >&2
  echo "Stack: $STACK_NAME; distribution: ${DISTRIBUTION_ID:-unknown}" >&2
  echo "CloudFormation outputs:" >&2
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs" \
    --output table >&2 || true
  echo "CloudFront resources in the stack:" >&2
  aws cloudformation list-stack-resources \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::CloudFront::Distribution'].[LogicalResourceId,PhysicalResourceId,ResourceStatus]" \
    --output table >&2 || true
  exit 1
fi

if [[ "$CLOUDFRONT_URL" != http://* && "$CLOUDFRONT_URL" != https://* ]]; then
  CLOUDFRONT_URL="https://${CLOUDFRONT_URL}"
fi

echo "Frontend deployment complete: $CLOUDFRONT_URL"
