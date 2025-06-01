
// src/lib/firebase.ts
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getStorage, FirebaseStorage } from 'firebase/storage';

// Check if NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is set and log a warning if not.
// This is a common source of issues if not configured correctly.
if (!process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) {
  console.warn(
    "WARNING: Firebase Storage bucket (NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) is not configured in your environment variables. " +
    "The Firebase SDK will attempt to use the default_bucket associated with your Firebase project if available. " +
    "If you encounter 'storage/unknown' or similar errors, please ensure this environment variable is correctly set in your .env file " +
    "to your Firebase project's storage bucket ID (e.g., 'your-project-id.appspot.com')."
  );
}

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, // This will be undefined if the env var is not set
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

let app: FirebaseApp;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

const storage: FirebaseStorage = getStorage(app);

export { app, storage };
