# Linux and AWS deployment

## Architecture

- `client`: Nginx serving the React production build on port 80.
- `server`: private Node.js API on Docker port 5100.
- `postgres`: private PostgreSQL 16 database with a persistent Docker volume.
- `cic_catalogs`: persistent volume for generated catalog files.

Only the client port is published. Nginx sends `/api/*` requests to the server over the private Docker network.

## Linux server requirements

- A supported 64-bit Linux distribution (Ubuntu 22.04/24.04 is recommended).
- Docker Engine with the Compose v2 plugin.
- At least 2 vCPU, 4 GB RAM, and sufficient disk for generated catalog files.
- Inbound port 80, and preferably 443 through an AWS Application Load Balancer.
- SSH access restricted to the client's office/VPN IP addresses.

## First deployment

```bash
git clone <repository-url>
cd cic-product-integration
cp deploy.env.example deploy.env
nano deploy.env
docker compose --env-file deploy.env up -d --build postgres server client
docker compose --env-file deploy.env --profile tools run --rm seed-admin
docker compose --env-file deploy.env ps
```

Use long, different, URL-safe values for `POSTGRES_PASSWORD` and `ADMIN_PASSWORD`. Never commit `deploy.env`.
Set `COOKIE_SECURE=false` for local HTTP testing and `COOKIE_SECURE=true` for production HTTPS.

Open `http://SERVER_IP/health` and `http://SERVER_IP/api/health` to verify the client and API/database respectively.

## Updating

```bash
git pull --ff-only
docker compose --env-file deploy.env up -d --build
docker image prune -f
```

Review the running containers and recent logs:

```bash
docker compose --env-file deploy.env ps
docker compose --env-file deploy.env logs --tail=200 server client postgres
```

## Backups

Database backup:

```bash
docker compose --env-file deploy.env exec -T postgres \
  pg_dump -U cic_user -d cic_catalogs -Fc > cic_catalogs_$(date +%F).dump
```

The generated catalog volume should also be included in the EC2/EBS snapshot or host backup policy. Test database restores periodically; an untested backup is not sufficient.

## Recommended AWS layout

For the simplest deployment:

1. One EC2 instance in a private or tightly restricted subnet.
2. An Application Load Balancer terminating HTTPS with an ACM certificate.
3. An ALB target group forwarding to EC2 port 80 and checking `/health`.
4. Route 53 (or the client's DNS provider) pointing the application domain to the ALB.
5. An encrypted EBS volume sized for PostgreSQL and generated catalogs.
6. AWS Backup snapshots and CloudWatch alarms for disk, CPU, memory, and instance health.
7. AWS Systems Manager Session Manager instead of public SSH when possible.

For higher availability, use ECS/Fargate for client/server and Amazon RDS PostgreSQL instead of the Compose PostgreSQL container. The current Compose setup is intended for a single Linux host.

## Information required from the AWS client

Ask the client for decisions/access through a secure channel:

- AWS account ID and target region.
- Deployment choice: EC2 Docker Compose or ECS/RDS.
- Approved instance type and monthly budget.
- VPC, subnet, and security-group requirements.
- Domain name and who controls its DNS.
- Whether an ACM certificate and Application Load Balancer already exist.
- Preferred deployment access: IAM role, SSO, or a dedicated least-privilege deploy user.
- EC2 access method: Systems Manager or SSH, including approved source IPs.
- Required storage capacity, retention period, and backup/restore policy.
- Production administrator username; obtain passwords/secrets separately.
- Monitoring/alert recipients and any compliance requirements.
- GitHub repository owner and the users/teams who need access.
- Whether CI/CD through GitHub Actions is required.

Do not request or commit the AWS root password. Do not put AWS access keys, SSH private keys, database passwords, or administrator passwords in GitHub. Prefer AWS SSO/IAM roles and store deployment secrets in GitHub Actions Secrets, AWS Secrets Manager, or an untracked `deploy.env` on the server.
