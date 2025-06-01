
// src/lib/s3Client.ts
import { S3Client } from "@aws-sdk/client-s3";

const OLA_S3_ENDPOINT = process.env.OLA_S3_ENDPOINT;
const OLA_S3_REGION = process.env.OLA_S3_REGION;
const OLA_S3_ACCESS_KEY_ID = process.env.OLA_S3_ACCESS_KEY_ID;
const OLA_S3_SECRET_ACCESS_KEY = process.env.OLA_S3_SECRET_ACCESS_KEY;
export const OLA_S3_BUCKET_NAME = process.env.OLA_S3_BUCKET_NAME;

if (!OLA_S3_ENDPOINT) {
  console.error("Missing Ola S3 Endpoint (OLA_S3_ENDPOINT) in environment variables. Uploads and site serving will fail.");
}
if (!OLA_S3_REGION) {
  console.error("Missing Ola S3 Region (OLA_S3_REGION) in environment variables. Using 'us-east-1' as default, but this may not be correct.");
}
if (!OLA_S3_ACCESS_KEY_ID) {
  console.error("Missing Ola S3 Access Key ID (OLA_S3_ACCESS_KEY_ID) in environment variables. Uploads and site serving will fail.");
}
if (!OLA_S3_SECRET_ACCESS_KEY) {
  console.error("Missing Ola S3 Secret Access Key (OLA_S3_SECRET_ACCESS_KEY) in environment variables. Uploads and site serving will fail.");
}
if (!OLA_S3_BUCKET_NAME) {
  console.error("Missing Ola S3 Bucket Name (OLA_S3_BUCKET_NAME) in environment variables. Uploads and site serving will fail.");
}

// Fallback for region if not set, though it's best to set it explicitly
const s3Region = OLA_S3_REGION || 'us-east-1';

class MissingS3ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingS3ConfigError";
  }
}

function getS3Client(): S3Client {
  if (!OLA_S3_ENDPOINT || !OLA_S3_ACCESS_KEY_ID || !OLA_S3_SECRET_ACCESS_KEY || !OLA_S3_BUCKET_NAME) {
    // This error will be thrown if essential configs are missing when the client is first accessed.
    // The console errors above provide immediate feedback on server start.
    throw new MissingS3ConfigError("Critical Ola S3 configuration is missing. Check .env file and server logs.");
  }
  return new S3Client({
    endpoint: OLA_S3_ENDPOINT,
    region: s3Region, // AWS SDK requires a region
    credentials: {
      accessKeyId: OLA_S3_ACCESS_KEY_ID,
      secretAccessKey: OLA_S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true, // Important for many S3-compatible services
  });
}

// Initialize lazily to catch config errors on first use rather than server start only.
let clientInstance: S3Client | null = null;

export const s3Client = (): S3Client => {
  if (!clientInstance) {
    clientInstance = getS3Client();
  }
  return clientInstance;
};
