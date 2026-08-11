import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

interface FrontendStackProps extends cdk.StackProps {
  nodeEnv: string;
  domainName: string;
  hostedZoneName: string;
  hostedZoneId: string;
  certificateArn: string;
  frontendBuildPath: string;
}

export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const production = props.nodeEnv === "production";
    const apiExportName = production
      ? "CicApiAlbDnsProduction"
      : "CicApiAlbDns";
    const apiAlbDns = cdk.Fn.importValue(apiExportName);
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "ExistingCertificate",
      props.certificateArn,
    );

    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    frontendBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [frontendBucket.arnForObjects("*")],
        principals: [oai.grantPrincipal],
      }),
    );

    const staticOrigin = new origins.S3Origin(frontendBucket, {
      originPath: "/app",
      originAccessIdentity: oai,
    });
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [props.domainName],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: staticOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "api/*": {
          origin: new origins.HttpOrigin(apiAlbDns, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: cdk.Duration.seconds(0),
      })),
    });

    new s3deploy.BucketDeployment(this, "FrontendDeployment", {
      sources: [s3deploy.Source.asset(props.frontendBuildPath)],
      destinationBucket: frontendBucket,
      destinationKeyPrefix: "app",
      distribution,
      distributionPaths: ["/*"],
      memoryLimit: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(1),
      prune: true,
      retainOnDelete: true,
    });

    new cdk.CfnOutput(this, "CloudFrontURL", {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, "CFID", {
      value: distribution.distributionId,
    });
  }
}
