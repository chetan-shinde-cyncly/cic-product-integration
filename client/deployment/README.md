# CIC Frontend AWS Deployment

This CDK app uploads the Webpack `dist` build to the retained S3 bucket under
`/app`, serves it through CloudFront, and proxies `/api/*` to the CIC backend
load balancer. CloudFront forwards cookies and disables caching for API calls.

Deploy the backend stack before this stack because the backend load-balancer
DNS name is imported through a CloudFormation export.

When `certificateArn` is omitted, the stack uses CloudFront's generated HTTPS
domain and connects to the backend load balancer over HTTP. Route 53 record
creation is intentionally disabled. A custom domain can be added later by
setting `certificateArn` and creating the corresponding DNS alias.
