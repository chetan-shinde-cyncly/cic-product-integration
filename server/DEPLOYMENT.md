# CIC AWS Deployment

The backend deployment uses AWS CDK to provision the CIC API, scheduler, data
storage, and networking integrations in the existing VPC.

## Architecture

- Existing VPC and public/private subnets
- ECS Fargate cluster
- Application load balancer (HTTP when no ACM certificate is configured)
- One development API task or two production API tasks
- One scheduler task per environment
- Encrypted PostgreSQL 16 RDS instance with generated credentials
- Private encrypted S3 bucket shared by API and scheduler tasks
- Ephemeral `/app/catalogs` cache hydrated from and reconciled to S3 every 15 seconds
- Secrets Manager secret for bootstrap administrator credentials
- Existing ECR repository; ACM certificate and DNS hosted zone are optional

RDS, catalog S3 data, database credentials, administrator credentials, the ECS cluster,
and frontend S3 content use retention policies. Deleting a stack will not
automatically delete retained data.

## Prerequisites

- AWS CLI authenticated to account `202061849983`
- Docker
- Node.js and npm
- `jq`
- AWS CDK bootstrap completed in `us-east-1`
- Permission to manage CloudFormation, ECS, ECR, ELB, RDS, Secrets
  Manager, IAM, EC2 security groups, S3, and CloudFront

## Configuration

Environment configuration is stored in:

- `deployment/config/dev.json`
- `deployment/config/prod.json`

### Existing server database

The existing Docker PostgreSQL service uses:

```env
PGHOST=postgres
PGPORT=5432
PGUSER=postgres
PGDATABASE=cic_catalogs
PGPASSWORD=<existing-server-password>
DATABASE_SSL=false
```

The password must remain in an untracked environment file or Secrets Manager.
The Docker hostname `postgres` is not automatically resolvable from ECS. The
current CDK configuration therefore continues to create RDS until a private
hostname or IP reachable from the ECS VPC is supplied for the existing server.
ECS tasks created by CDK use `DATABASE_SSL=true`, as RDS requires encrypted
connections. The example above remains `false` only for local Docker PostgreSQL.

The API listens on port `5100` and reports health at `/api/health`. API tasks
report scheduler configuration but do not arm an automatic timer. The dedicated
worker runs the scheduler at 06:00 IST with three minutes between selected
catalogs.

## EFS to S3 cutover

The old filesystem has a `RETAIN` removal policy, so the CDK update detaches it
without deleting its data. Perform the copy before allowing the new API and
scheduler tasks to write catalog data:

1. Record the current `FileSystemId` shared-stack output and stop the API and
   scheduler services (set desired count to zero).
2. Deploy only the shared stack with the default `retainLegacyEfs=true` context.
   This creates `CatalogBucketName` while deliberately keeping EFS and its old
   cross-stack exports available:

   ```bash
   cd deployment
   npm ci
   npx cdk deploy CICSharedStack --require-approval never --context env=dev
   ```

   Use `CICProductionSharedStack` and `--context env=prod` for production.

3. Mount the retained EFS on an EC2 instance in the VPC, with its former access
   point mounted so that the catalog files are the source directory.
4. Copy and verify the files:

   ```bash
   ./scripts/migrate-catalogs-to-s3.sh \
     --source /mnt/cic-catalogs \
     --bucket "$(aws cloudformation describe-stacks \
       --stack-name CICSharedStack \
       --query \"Stacks[0].Outputs[?OutputKey=='CatalogBucketName'].OutputValue\" \
       --output text)" \
     --region us-east-1
   ```

5. Run `./deploy.sh --env dev` (or `./deploy-prod.sh`) to publish the new image
   and deploy all stacks. Their task roles receive access only to
   the catalog bucket; no NFS mount or EFS security-group rule remains.
6. Confirm both task logs contain `S3 catalog storage hydrated.` and verify the
   migrated downloads.
7. Remove the legacy resources and compatibility exports only after the API and
   worker stacks have finished switching to S3:

   ```bash
   cd deployment
   npx cdk deploy CICSharedStack --require-approval never \
     --context env=dev --context retainLegacyEfs=false
   ```

   Use the production stack and environment context for production. EFS has a
   retention policy, so delete the retained filesystem manually only after the
   cutover has been verified.

Production uses S3 versioning with noncurrent versions retained for 30 days.
S3 changes made by one task are visible to the other task after the next sync,
normally within 15 seconds. Local development continues to use `server/catalogs`
when `CATALOG_STORAGE_BUCKET` is unset.

## Deployment order

Deploy the backend first because the frontend stack imports the backend load
balancer DNS output.

```bash
cd server
./deploy.sh --env dev

cd ../client
./deploy.sh --env dev
```

For production:

```bash
cd server
./deploy-prod.sh

cd ../client
./deploy-prod.sh
```

The scripts create the named ECR repository if missing, push the `latest`
image, deploy CDK, and force API and scheduler service replacement.

## After deployment

1. Read `AppAuthSecretArn` from the shared-stack outputs.
2. Retrieve the generated login from Secrets Manager.
3. Create the DNS records for `cic.my.dev.broadlume.com` and
   `cic.web.cyncly.com`; Route 53 creation is intentionally disabled.
4. Confirm `/api/health` through CloudFront.
5. Sign in and configure daily-refresh catalog selections.
6. Confirm `/api/daily-refresh/status` shows a non-null `nextRunAt` from the
   scheduler logs.

Because the image tag is `latest`, deployment scripts force a new ECS rollout
after pushing each image.
