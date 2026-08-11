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

ACCOUNT=$(jq -r '.account' "$CONFIG_FILE")
REGION=$(jq -r '.region' "$CONFIG_FILE")
REPOSITORY=$(jq -r '.ecrRepoName' "$CONFIG_FILE")
STACK_PREFIX=$(jq -r '.stackPrefix' "$CONFIG_FILE")
API_SERVICE=$(jq -r '.api.serviceName' "$CONFIG_FILE")
WORKER_SERVICE=$(jq -r '.worker.serviceName' "$CONFIG_FILE")
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${REPOSITORY}:latest"

echo "Deploying CIC backend to $ENVIRONMENT ($REGION)."
aws ecr describe-repositories --repository-names "$REPOSITORY" --region "$REGION" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$REPOSITORY" --region "$REGION" >/dev/null
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$REGISTRY"
docker build --pull -t "$IMAGE" .
docker push "$IMAGE"

pushd deployment >/dev/null
npm ci
npx cdk deploy --all --require-approval never --context env="$ENVIRONMENT"
popd >/dev/null

CLUSTER=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}SharedStack" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" \
  --output text 2>/dev/null || true)

if [[ -n "$CLUSTER" && "$CLUSTER" != "None" ]]; then
  aws ecs update-service --cluster "$CLUSTER" --service "$API_SERVICE" \
    --force-new-deployment --region "$REGION" >/dev/null
  aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" \
    --force-new-deployment --region "$REGION" >/dev/null
fi

echo "Backend deployment complete."
