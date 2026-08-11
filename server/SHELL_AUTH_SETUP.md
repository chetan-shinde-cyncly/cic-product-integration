# CIC Authentication Setup

CIC keeps its existing PostgreSQL-backed username/password authentication. It
does not use the RFMS Cognito or BroadlumeX Shell authentication integration.

The AWS deployment creates a Secrets Manager secret containing a generated
bootstrap administrator username and password. CDK injects those values into
the API task as `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

After deploying the shared backend stack, retrieve the secret ARN from the
`AppAuthSecretArn` CloudFormation output. Authorized operators can retrieve its
value from AWS Secrets Manager. Do not commit the secret value.

Authentication endpoints are documented in `AUTH_README.md`. Production uses
the secure `cicSession` HTTP-only cookie and CloudFront forwards cookies to the
API load balancer.
