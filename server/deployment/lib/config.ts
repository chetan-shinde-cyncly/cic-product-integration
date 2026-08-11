import * as fs from "fs";
import * as path from "path";

export interface DeploymentConfig {
  // AWS Account & Region
  account: string;
  region: string;

  // Infrastructure
  vpcId: string;
  publicSubnetIds: string[];
  privateSubnetIds: string[];

  // ECR
  ecrRepoName: string;

  // Stack Naming
  stackPrefix: string;

  // Hosted Zone
  hostedZoneId: string;
  hostedZoneName: string;

  // SSL Certificate
  certificateArn: string;

  // Service Configuration
  api: {
    serviceName: string;
    cpu: number;
    memory: number;
    desiredCount: number;
    containerPort: number;
    healthCheckPath: string;
    healthCheckInterval: number;
    healthCheckTimeout: number;
  };

  worker: {
    serviceName: string;
    cpu: number;
    memory: number;
    desiredCount: number;
  };

  database: {
    name: string;
    instanceType: string;
    allocatedStorage: number;
    maxAllocatedStorage: number;
    backupRetentionDays: number;
  };

  scheduler: {
    enabled: boolean;
    hourIst: number;
    minuteIst: number;
    lang: string;
    spacingMinutes: number;
  };

  // Environment
  nodeEnv: string;
}

let cachedConfig: DeploymentConfig | null = null;

export function loadConfig(env: string): DeploymentConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.join(__dirname, `../config/${env}.json`);
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  
  // Set defaults for optional fields
  const config: DeploymentConfig = configData;

  cachedConfig = config;
  return config;
}

export function getConfig(): DeploymentConfig {
  if (!cachedConfig) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return cachedConfig as DeploymentConfig;
}
