// src/app/sites/[...filePath]/route.ts
import { type NextRequest, NextResponse } from 'next/server';
import { s3Client, OLA_S3_BUCKET_NAME } from '@/lib/s3Client';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import pathUtil from 'path';

async function tryServePathFromS3(s3KeyToTry: string): Promise<NextResponse | null> {
  if (!OLA_S3_BUCKET_NAME) {
    console.error("S3 Bucket name not configured for serving files.");
    throw new Error("S3_BUCKET_NAME_NOT_CONFIGURED"); 
  }
  const currentS3Client = s3Client();
  console.log(`[S3 Route] Attempting to serve from S3 key: ${s3KeyToTry}`);

  try {
    const getObjectParams = {
      Bucket: OLA_S3_BUCKET_NAME,
      Key: s3KeyToTry,
    };

    let s3Metadata;
    try {
      const headCommand = new HeadObjectCommand(getObjectParams);
      s3Metadata = await currentS3Client.send(headCommand);
      console.log(`[S3 Route] HeadObject success for ${s3KeyToTry}. ContentType: ${s3Metadata.ContentType}, Length: ${s3Metadata.ContentLength}`);
    } catch (headError: any) {
      if (headError.name === 'NoSuchKey' || headError.name === 'NotFound' || (headError.$metadata && headError.$metadata.httpStatusCode === 404)) {
        console.log(`[S3 Route] HeadObject: File not found (404) for ${s3KeyToTry}`);
        return null; 
      }
      console.error(`[S3 Route] S3 HeadObject error for '${s3KeyToTry}':`, headError.name, headError.message);
      throw headError; 
    }
    
    const command = new GetObjectCommand(getObjectParams);
    const s3ObjectOutput = await currentS3Client.send(command);

    if (!s3ObjectOutput.Body) {
      console.error(`[S3 Route] S3 object body is empty for key: ${s3KeyToTry}`);
      return NextResponse.json({ error: 'S3 object body is empty.' }, { status: 500 });
    }

    const contentType = s3Metadata.ContentType || s3ObjectOutput.ContentType || 'application/octet-stream';
    const contentLength = s3Metadata.ContentLength?.toString() || s3ObjectOutput.ContentLength?.toString();
    const cacheControl = s3Metadata.CacheControl || s3ObjectOutput.CacheControl || 'public, max-age=3600';

    console.log(`[S3 Route] Serving file ${s3KeyToTry} with Content-Type: ${contentType}`);
    return new NextResponse(s3ObjectOutput.Body as any, { 
      status: 200,
      headers: {
        'Content-Type': contentType,
        ...(contentLength && { 'Content-Length': contentLength }),
        'Cache-Control': cacheControl,
      },
    });

  } catch (error: any) {
    if (error.name === 'NoSuchKey' || error.name === 'NotFound' || (error.$metadata && error.$metadata.httpStatusCode === 404)) {
      console.log(`[S3 Route] GetObject: File not found (404) for ${s3KeyToTry} (after successful HeadObject, which is odd, or HeadObject was skipped).`);
      return null; 
    }
    console.error(`[S3 Route] Error fetching '${s3KeyToTry}' from S3:`, error.name, error.message, error);
    throw error; 
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { filePath: string[] } }
) {
  const filePathArray = params.filePath; 
  console.log(`[S3 Route] Received request for filePath: ${filePathArray.join('/')}`);

  // Expected path: users/<userId>/sites/<projectName>/[...actualFilePath]
  // So, filePathArray[0] should be "users", filePathArray[1] is userId, filePathArray[2] is "sites", filePathArray[3] is projectName
  if (!filePathArray || filePathArray.length < 4 || filePathArray[0] !== 'users' || filePathArray[2] !== 'sites') {
    console.log(`[S3 Route] Invalid path structure. Expected 'users/<userId>/sites/<projectName>/...'. Received: ${filePathArray.join('/')}`);
    return NextResponse.json({ error: 'Invalid project path structure.' }, { status: 400 });
  }
  
  try {
    s3Client(); 
    if (!OLA_S3_BUCKET_NAME) {
      throw new Error("S3 bucket (OLA_S3_BUCKET_NAME) is not configured in environment variables.");
    }
  } catch (configError: any) {
     console.error('[S3 Route] S3 Configuration error:', configError.message);
     return NextResponse.json({ error: 'Server configuration error for S3 storage.', details: configError.message }, { status: 500 });
  }

  // Construct the base S3 key from the filePathArray
  // Example: if filePathArray is ['users', 'test-user', 'sites', 'my-cool-app', 'index.html']
  // s3PathPrefix will be 'users/test-user/sites/my-cool-app'
  // relativeFile will be 'index.html'
  const s3FullKeyPath = filePathArray.join('/'); 

  const originalRequestPathEndsWithSlash = request.nextUrl.pathname.endsWith('/');
  let attemptedPathsInfo: {s3Key: string, attempted: boolean}[] = [];

  const attemptServe = async (s3Key: string) => {
    attemptedPathsInfo.push({ s3Key, attempted: true });
    return tryServePathFromS3(s3Key);
  };

  try {
    // Path directly requested, or if it ends with a slash, try index.html in that "directory"
    let primaryS3Key = s3FullKeyPath;
    if (originalRequestPathEndsWithSlash) {
      primaryS3Key = (s3FullKeyPath.endsWith('/') ? s3FullKeyPath : s3FullKeyPath + '/') + 'index.html';
      primaryS3Key = primaryS3Key.replace(/\/\//g, '/'); // Normalize double slashes
    }
    
    console.log(`[S3 Route] Primary attempt for S3 key: ${primaryS3Key}`);
    let response = await attemptServe(primaryS3Key);
    if (response) return response;

    // If the original request didn't end with a slash, AND it's not an explicit file (no extension),
    // AND primary attempt failed, try serving index.html from it as if it were a directory.
    // Example: /sites/users/test-user/sites/my-cool-app/about -> try users/test-user/sites/my-cool-app/about/index.html
    if (!originalRequestPathEndsWithSlash && !pathUtil.extname(s3FullKeyPath)) {
      const directoryIndexS3Key = (s3FullKeyPath.endsWith('/') ? s3FullKeyPath : s3FullKeyPath + '/') + 'index.html';
      const normalizedDirIndexKey = directoryIndexS3Key.replace(/\/\//g, '/');
      
      if (!attemptedPathsInfo.find(p => p.s3Key === normalizedDirIndexKey && p.attempted)) {
        console.log(`[S3 Route] Fallback attempt for directory index: ${normalizedDirIndexKey}`);
        response = await attemptServe(normalizedDirIndexKey);
        if (response) return response;
      }
    }
    
    const attemptedS3Keys = attemptedPathsInfo.filter(p => p.attempted).map(p => p.s3Key);
    console.log(`[S3 Route] File not found after attempts. Tried: ${attemptedS3Keys.join(', ')}`);
    return NextResponse.json({ error: 'File not found.', triedS3Keys: attemptedS3Keys }, { status: 404 });

  } catch (error: any) {
    console.error('[S3 Route] Unhandled error in S3 proxy GET handler:', error);
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
