
// src/app/sites/[...filePath]/route.ts
import { type NextRequest, NextResponse } from 'next/server';
import { s3Client, OLA_S3_BUCKET_NAME } from '@/lib/s3Client';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import pathUtil from 'path'; // For pathUtil.extname, renamed to avoid conflict

async function tryServePathFromS3(s3KeyToTry: string): Promise<NextResponse | null> {
  if (!OLA_S3_BUCKET_NAME) {
    console.error("S3 Bucket name not configured for serving files.");
    // Throw an error that will be caught by the main try-catch and result in a 500
    throw new Error("S3_BUCKET_NAME_NOT_CONFIGURED"); 
  }
  const currentS3Client = s3Client();

  try {
    const getObjectParams = {
      Bucket: OLA_S3_BUCKET_NAME,
      Key: s3KeyToTry,
    };

    let s3Metadata;
    try {
      const headCommand = new HeadObjectCommand(getObjectParams);
      s3Metadata = await currentS3Client.send(headCommand);
    } catch (headError: any) {
      // Common S3 error names for object not found
      if (headError.name === 'NoSuchKey' || headError.name === 'NotFound' || (headError.$metadata && headError.$metadata.httpStatusCode === 404)) {
        return null; // File not found
      }
      console.error(`S3 HeadObject error for '${s3KeyToTry}':`, headError.name, headError.message);
      throw headError; // Other head error, let main handler deal with it
    }
    
    // If HeadObject was successful, proceed to GetObject
    const command = new GetObjectCommand(getObjectParams);
    const s3ObjectOutput = await currentS3Client.send(command);

    if (!s3ObjectOutput.Body) {
      console.error(`S3 object body is empty for key: ${s3KeyToTry}`);
      return NextResponse.json({ error: 'S3 object body is empty.' }, { status: 500 });
    }

    const contentType = s3Metadata.ContentType || s3ObjectOutput.ContentType || 'application/octet-stream';
    const contentLength = s3Metadata.ContentLength?.toString() || s3ObjectOutput.ContentLength?.toString();
    const cacheControl = s3Metadata.CacheControl || s3ObjectOutput.CacheControl || 'public, max-age=3600'; // Default cache

    return new NextResponse(s3ObjectOutput.Body as any, { // Cast to any for ReadableStream
      status: 200,
      headers: {
        'Content-Type': contentType,
        ...(contentLength && { 'Content-Length': contentLength }),
        'Cache-Control': cacheControl,
      },
    });

  } catch (error: any) {
    // Double check for not found errors that might not have been caught by HeadObject phase
    if (error.name === 'NoSuchKey' || error.name === 'NotFound' || (error.$metadata && error.$metadata.httpStatusCode === 404)) {
      return null; // File not found
    }
    console.error(`Error fetching '${s3KeyToTry}' from S3:`, error.name, error.message, error);
    throw error; // Rethrow to be caught by the main try-catch
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { filePath: string[] } }
) {
  const filePathArray = params.filePath; 

  if (!filePathArray || filePathArray.length === 0) {
    return NextResponse.json({ error: 'Project name is required.' }, { status: 400 });
  }
  
  try {
    s3Client(); // Initialize client early to catch config errors
    if (!OLA_S3_BUCKET_NAME) {
      throw new Error("S3 bucket (OLA_S3_BUCKET_NAME) is not configured in environment variables.");
    }
  } catch (configError: any) {
     console.error('S3 Configuration error:', configError.message);
     return NextResponse.json({ error: 'Server configuration error for S3 storage.', details: configError.message }, { status: 500 });
  }


  const projectName = filePathArray[0];
  const relativePathSegments = filePathArray.slice(1);
  let relativePath = relativePathSegments.join('/');
  relativePath = relativePath.replace(/^\/+|\/+$/g, ''); // Normalize

  const originalRequestPath = request.nextUrl.pathname;
  let attemptedPathsInfo: {s3Key: string, attempted: boolean}[] = [];

  const attemptServe = async (s3Key: string) => {
    attemptedPathsInfo.push({ s3Key, attempted: true });
    return tryServePathFromS3(s3Key);
  };

  try {
    let primaryPathSuffix = relativePath;
    if (relativePath === '' || originalRequestPath.endsWith('/')) {
      primaryPathSuffix = (relativePath ? relativePath + '/' : '') + 'index.html';
    }
    primaryPathSuffix = primaryPathSuffix.replace(/\/\//g, '/');
    let primaryS3Key = `sites/${projectName}/${primaryPathSuffix}`.replace(/^\/+/, '');
    
    let response = await attemptServe(primaryS3Key);
    if (response) return response;

    if (!originalRequestPath.endsWith('/') && relativePath !== '' && !pathUtil.extname(relativePath)) {
      const directoryIndexS3KeySuffix = `${relativePath}/index.html`.replace(/\/\//g, '/');
      const directoryIndexS3Key = `sites/${projectName}/${directoryIndexS3KeySuffix}`.replace(/^\/+/, '');
      
      if (!attemptedPathsInfo.find(p => p.s3Key === directoryIndexS3Key && p.attempted)) {
        response = await attemptServe(directoryIndexS3Key);
        if (response) return response;
      }
    }
    
    const attemptedS3Keys = attemptedPathsInfo.filter(p => p.attempted).map(p => p.s3Key);
    return NextResponse.json({ error: 'File not found.', triedS3Keys: attemptedS3Keys }, { status: 404 });

  } catch (error: any) {
    console.error('Unhandled error in S3 proxy GET handler:', error);
    const attemptedS3Keys = attemptedPathsInfo.filter(p => p.attempted).map(p => p.s3Key);
    let errorMessage = 'Error fetching file from S3 storage.';
    if (error.message === "S3_BUCKET_NAME_NOT_CONFIGURED" || error.name === "MissingS3ConfigError") {
        errorMessage = "S3 storage is not configured correctly on the server.";
    } else if (error.name) {
        errorMessage = `S3 Error (${error.name}): ${error.message}`;
    }

    return NextResponse.json({ error: errorMessage, details: (error as Error).message, triedS3Keys: attemptedS3Keys }, { status: 500 });
  }
}
