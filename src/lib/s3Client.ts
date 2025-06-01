
// src/lib/s3Client.ts
import { S3Client } from "@aws-sdk/client-s3";

const OLA_S3_ENDPOINT = process.env.OLA_S3_ENDPOINT;
const OLA_S3_REGION = process.env.OLA_S3_REGION;
const OLA_S3_ACCESS_KEY_ID = process.env.OLA_S3_ACCESS_KEY_ID;
const OLA_S3_SECRET_ACCESS_KEY = process.env.OLA_S3_SECRET_ACCESS_KEY;
export const OLA_S3_BUCKET_NAME = process.env.OLA_S3_BUCKET_NAME;

// Comprehensive startup checks for S3 configuration
const criticalS3ConfigErrors: string[] = [];
if (!OLA_S3_ENDPOINT) {
  criticalS3ConfigErrors.push("OLA_S3_ENDPOINT is not defined in environment variables.");
} else if (!OLA_S3_ENDPOINT.startsWith('http://') && !OLA_S3_ENDPOINT.startsWith('https://')) {
  criticalS3ConfigErrors.push(`OLA_S3_ENDPOINT ("${OLA_S3_ENDPOINT}") is not a valid URL. It must start with http:// or https://.`);
}
if (!OLA_S3_ACCESS_KEY_ID) {
  criticalS3ConfigErrors.push("OLA_S3_ACCESS_KEY_ID is not defined in environment variables.");
}
if (!OLA_S3_SECRET_ACCESS_KEY) {
  criticalS3ConfigErrors.push("OLA_S3_SECRET_ACCESS_KEY is not defined in environment variables.");
}
if (!OLA_S3_BUCKET_NAME) {
  criticalS3ConfigErrors.push("OLA_S3_BUCKET_NAME is not defined in environment variables.");
}

if (criticalS3ConfigErrors.length > 0) {
  criticalS3ConfigErrors.forEach(msg => console.error(`CRITICAL S3 CONFIG ERROR: ${msg} S3 operations will likely fail.`));
}

if (!OLA_S3_REGION && criticalS3ConfigErrors.length === 0) { // Only warn if other critical errors are not present
  console.warn("WARNING: OLA_S3_REGION is not set in environment variables. Defaulting to 'us-east-1', but please verify this is correct for your Ola S3 provider.");
}


export class MissingS3ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingS3ConfigError";
  }
}

function getS3Client(): S3Client {
  // Re-check critical variables at the time of client creation
  if (!OLA_S3_ENDPOINT || (!OLA_S3_ENDPOINT.startsWith('http://') && !OLA_S3_ENDPOINT.startsWith('https://'))) {
    throw new MissingS3ConfigError("OLA_S3_ENDPOINT is missing or invalid. This is required for S3 client initialization.");
  }
  if (!OLA_S3_ACCESS_KEY_ID) {
    throw new MissingS3ConfigError("OLA_S3_ACCESS_KEY_ID is not defined. This is required for S3 client initialization.");
  }
  if (!OLA_S3_SECRET_ACCESS_KEY) {
    throw new MissingS3ConfigError("OLA_S3_SECRET_ACCESS_KEY is not defined. This is required for S3 client initialization.");
  }
  if (!OLA_S3_BUCKET_NAME) {
    // Though bucket name isn't used for client config itself, it's essential for operations.
    // This function is now the single point of truth for "is S3 usable?"
    throw new MissingS3ConfigError("OLA_S3_BUCKET_NAME is not defined. This is required for S3 operations.");
  }

  const s3Region = OLA_S3_REGION || 'us-east-1';

  return new S3Client({
    endpoint: OLA_S3_ENDPOINT,
    region: s3Region,
    credentials: {
      accessKeyId: OLA_S3_ACCESS_KEY_ID,
      secretAccessKey: OLA_S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true, // Important for many S3-compatible services
  });
}

let clientInstance: S3Client | null = null;
let s3ClientError: Error | null = null;

export const s3Client = (): S3Client => {
  if (s3ClientError) {
    // If initialization previously failed, throw that error again.
    throw s3ClientError;
  }
  if (!clientInstance) {
    try {
      clientInstance = getS3Client();
    } catch (error) {
      s3ClientError = error as Error; // Store the initialization error
      console.error("Failed to initialize S3 client:", s3ClientError.message);
      throw s3ClientError; // Rethrow
    }
  }
  return clientInstance;
};
