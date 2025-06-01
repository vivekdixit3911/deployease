
// src/lib/s3Client.ts
import { S3Client } from "@aws-sdk/client-s3";

const OLA_S3_ENDPOINT = process.env.OLA_S3_ENDPOINT;
const OLA_S3_REGION = process.env.OLA_S3_REGION;
const OLA_S3_ACCESS_KEY_ID = process.env.OLA_S3_ACCESS_KEY_ID;
const OLA_S3_SECRET_ACCESS_KEY = process.env.OLA_S3_SECRET_ACCESS_KEY;
export const OLA_S3_BUCKET_NAME = process.env.OLA_S3_BUCKET_NAME;

// Initial checks on server startup for quick feedback
if (!OLA_S3_ENDPOINT) {
  console.error("CRITICAL ERROR: OLA_S3_ENDPOINT is not defined in environment variables. S3 operations will fail.");
} else if (!OLA_S3_ENDPOINT.startsWith('http://') && !OLA_S3_ENDPOINT.startsWith('https://')) {
  console.error(`CRITICAL ERROR: OLA_S3_ENDPOINT ("${OLA_S3_ENDPOINT}") is not a valid URL. It must start with http:// or https://. S3 operations will fail.`);
}
if (!OLA_S3_REGION) {
  console.warn("WARNING: OLA_S3_REGION is not set in environment variables. Defaulting to 'us-east-1', but please verify this is correct for your Ola S3 provider.");
}
if (!OLA_S3_ACCESS_KEY_ID) {
  console.error("CRITICAL ERROR: OLA_S3_ACCESS_KEY_ID is not defined in environment variables. S3 operations will fail.");
}
if (!OLA_S3_SECRET_ACCESS_KEY) {
  console.error("CRITICAL ERROR: OLA_S3_SECRET_ACCESS_KEY is not defined in environment variables. S3 operations will fail.");
}
if (!OLA_S3_BUCKET_NAME) {
  console.error("CRITICAL ERROR: OLA_S3_BUCKET_NAME is not defined in environment variables. S3 operations will fail.");
}


class MissingS3ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingS3ConfigError";
  }
}

function getS3Client(): S3Client {
  if (!OLA_S3_ENDPOINT) {
    throw new MissingS3ConfigError("OLA_S3_ENDPOINT is not defined. This is required for S3 client initialization.");
  }
  if (!OLA_S3_ENDPOINT.startsWith('http://') && !OLA_S3_ENDPOINT.startsWith('https://')) {
    throw new MissingS3ConfigError(`OLA_S3_ENDPOINT ("${OLA_S3_ENDPOINT}") is not a valid URL. It must start with http:// or https://.`);
  }
  if (!OLA_S3_ACCESS_KEY_ID) {
    throw new MissingS3ConfigError("OLA_S3_ACCESS_KEY_ID is not defined. This is required for S3 client initialization.");
  }
  if (!OLA_S3_SECRET_ACCESS_KEY) {
    throw new MissingS3ConfigError("OLA_S3_SECRET_ACCESS_KEY is not defined. This is required for S3 client initialization.");
  }
  if (!OLA_S3_BUCKET_NAME) {
    throw new MissingS3ConfigError("OLA_S3_BUCKET_NAME is not defined. This is required for S3 client initialization.");
  }

  const s3Region = OLA_S3_REGION || 'us-east-1'; // Default if not set, with prior warning

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

// Initialize lazily to catch config errors on first use rather than server start only for thrown errors.
let clientInstance: S3Client | null = null;

export const s3Client = (): S3Client => {
  if (!clientInstance) {
    // This call will throw MissingS3ConfigError if critical configs are bad
    // The console.error/warn above give immediate feedback on startup.
    clientInstance = getS3Client();
  }
  return clientInstance;
};
