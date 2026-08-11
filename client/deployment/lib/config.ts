import * as fs from "fs";
import * as path from "path";

export interface DeploymentConfig {
  // AWS Account & Region
  account: string;
  region: string;

  // Environment
  nodeEnv: string;
  
  // Stack Naming
  stackPrefix: string;

  // Domain Configuration
  domainName: string;
  hostedZoneName: string;
  hostedZoneId: string;

  // SSL Certificate
  certificateArn: string;

  // Build Path
  frontendBuildPath: string;
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

  const config: DeploymentConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  
  cachedConfig = config;
  return config;
}

export function getConfig(): DeploymentConfig {
  if (!cachedConfig) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return cachedConfig as DeploymentConfig;
}
