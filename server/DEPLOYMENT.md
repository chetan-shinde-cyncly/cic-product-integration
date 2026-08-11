# CIC AWS Deployment

The backend deployment uses AWS CDK to provision the CIC API, scheduler, data
storage, and networking integrations in the existing VPC.

## Architecture

- Existing VPC and public/private subnets
- ECS Fargate cluster
- HTTPS application load balancer
- One development API task or two production API tasks
- One scheduler task per environment
- Encrypted PostgreSQL 16 RDS instance with generated credentials
- Encrypted EFS mounted at `/app/catalogs` by API and scheduler tasks
- Secrets Manager secret for bootstrap administrator credentials
- Existing ECR repository, ACM certificate, and DNS hosted zone

RDS, EFS, database credentials, administrator credentials, the ECS cluster,
and frontend S3 content use retention policies. Deleting a stack will not
automatically delete retained data.

## Prerequisites

- AWS CLI authenticated to account `202061849983`
- Docker
- Node.js and npm
- `jq`
- AWS CDK bootstrap completed in `us-east-1`
- Permission to manage CloudFormation, ECS, ECR, ELB, RDS, EFS, Secrets
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

The API listens on port `5100` and reports health at `/api/health`. API tasks
report scheduler configuration but do not arm an automatic timer. The dedicated
worker runs the scheduler at 06:00 IST with three minutes between selected
catalogs.

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
