
// src/app/sites/[...filePath]/route.ts
import { type NextRequest, NextResponse } from 'next/server';
import { storage } from '@/lib/firebase';
import { ref, getBlob, getMetadata } from 'firebase/storage';
import path from 'path'; // For path.extname

async function tryServePath(storagePathToTry: string): Promise<NextResponse | null> {
  try {
    const fileRef = ref(storage, storagePathToTry);
    // Must get metadata first to check existence and content type before blob
    const metadata = await getMetadata(fileRef); 
    const blob = await getBlob(fileRef);
    
    const contentType = metadata.contentType || 'application/octet-stream';
    const cacheControl = metadata.cacheControl || 'public, max-age=3600'; // Default cache

    return new NextResponse(blob, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': blob.size.toString(),
        'Cache-Control': cacheControl,
      },
    });
  } catch (error: any) {
    if (error.code === 'storage/object-not-found') {
      return null; // File not found, return null to indicate this
    }
    // For other errors, log and rethrow or return a 500
    console.error(`Error fetching '${storagePathToTry}' from Firebase Storage:`, error);
    // Rethrow to be caught by the main try-catch
    throw error; 
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

  const projectName = filePathArray[0];
  const relativePathSegments = filePathArray.slice(1);
  let relativePath = relativePathSegments.join('/');

  // Normalize: remove leading/trailing slashes from user input for consistency internally
  relativePath = relativePath.replace(/^\/+|\/+$/g, '');

  const originalRequestPath = request.nextUrl.pathname;
  let attemptedPaths: string[] = [];

  try {
    // Construct the primary path to try in Firebase Storage
    // If the path is empty (root of project) or original request ended with '/', assume directory and serve index.html
    let primaryStoragePathSuffix = relativePath;
    if (relativePath === '' || originalRequestPath.endsWith('/')) {
      primaryStoragePathSuffix = (relativePath ? relativePath + '/' : '') + 'index.html';
    }
    // Normalize potential double slashes if relativePath was empty and an index.html was appended
    primaryStoragePathSuffix = primaryStoragePathSuffix.replace(/\/\//g, '/');
    let primaryPathToTry = `sites/${projectName}/${primaryStoragePathSuffix}`;
    
    attemptedPaths.push(primaryPathToTry);
    let response = await tryServePath(primaryPathToTry);
    if (response) return response;

    // If the first attempt failed (e.g., it wasn't `folder/index.html` or `file.js`)
    // AND the original request did not end with a slash (e.g. /sites/proj/folder, not /sites/proj/folder/)
    // AND it's not an empty relative path (already handled)
    // AND it doesn't obviously look like a file with an extension,
    // then try treating it as a directory and append /index.html.
    // This handles cases like /sites/myproject/about -> try sites/myproject/about/index.html
    if (!originalRequestPath.endsWith('/') && relativePath !== '' && !path.extname(relativePath)) {
      const directoryIndexPathSuffix = `${relativePath}/index.html`.replace(/\/\//g, '/');
      const directoryIndexPath = `sites/${projectName}/${directoryIndexPathSuffix}`;
      
      if (!attemptedPaths.includes(directoryIndexPath)){ // Avoid re-trying the same path if logic overlaps
        attemptedPaths.push(directoryIndexPath);
        response = await tryServePath(directoryIndexPath);
        if (response) return response;
      }
    }
    
    // If all attempts fail, return 404
    return NextResponse.json({ error: 'File not found.', tried: attemptedPaths }, { status: 404 });

  } catch (error: any) {
    // Catch errors rethrown from tryServePath or other unexpected errors
    console.error('Unhandled error in Firebase Storage proxy:', error);
    return NextResponse.json({ error: 'Error fetching file from storage.', details: (error as Error).message, tried: attemptedPaths }, { status: 500 });
  }
}
