// src/lib/firebase.ts
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider } from 'firebase/auth';
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics';

// Your web app's Firebase configuration, now loaded from environment variables
export const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  // measurementId is optional and can be added if needed
  // measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
};

let app: FirebaseApp;
let analytics: Analytics | undefined;

// Log the config being used, but be careful not to log sensitive keys in production logs.
// For local development, this can be helpful.
console.log(`[Firebase Setup Attempt] Using config - Project ID: ${firebaseConfig.projectId}, Auth Domain: ${firebaseConfig.authDomain}`);

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  console.error("CRITICAL: Firebase configuration (apiKey or projectId) is missing. Ensure NEXT_PUBLIC_FIREBASE_* environment variables are set.");
}

if (!getApps().length) {
  if (firebaseConfig.apiKey && firebaseConfig.projectId) {
    app = initializeApp(firebaseConfig);
    console.log(`[Firebase Setup] Successfully Initialized NEW Firebase app with projectId: ${firebaseConfig.projectId}, authDomain: ${firebaseConfig.authDomain}`);
  } else {
    console.error("[Firebase Setup] Cannot initialize Firebase: API key or Project ID is missing from environment variables.");
    // Create a dummy app or handle this state appropriately if initialization fails
    // This line is problematic if init fails, so we ensure app is defined if we proceed.
    // For now, if config is missing, auth and other services will fail later.
  }
} else {
  app = getApps()[0];
  if (app.options.projectId !== firebaseConfig.projectId) {
    console.warn(`[Firebase Setup] Mismatch! Existing app projectId (${app.options.projectId}) does not match new config projectId (${firebaseConfig.projectId}). Re-initializing if possible, or using existing.`);
    // Potentially re-initialize if robust multi-project handling is needed, though complex client-side.
    // For now, we'll log the warning and proceed with the first initialized app.
    // If re-initialization is critical:
    // if (firebaseConfig.apiKey && firebaseConfig.projectId) {
    //   app = initializeApp(firebaseConfig, `app-${firebaseConfig.projectId}`); // Unique name
    // }
  } else {
    console.log(`[Firebase Setup] Successfully Used EXISTING Firebase app instance for projectId: ${app!.options.projectId}, authDomain: ${app!.options.authDomain}`);
  }
}

// Initialize Analytics if supported and app is initialized
if (typeof app !== 'undefined') {
  isSupported().then((supported) => {
    if (supported) {
      analytics = getAnalytics(app);
      console.log("[Firebase Setup] Firebase Analytics initialized.");
    } else {
      console.log("[Firebase Setup] Firebase Analytics is not supported in this environment.");
    }
  }).catch(error => {
    console.error("[Firebase Setup] Error checking Analytics support or initializing Analytics:", error);
  });
} else {
  console.warn("[Firebase Setup] Firebase app was not initialized, skipping Analytics setup.");
}

// Ensure auth is only initialized if app was successfully initialized
const auth = typeof app !== 'undefined' ? getAuth(app) : undefined;
const googleProvider = typeof app !== 'undefined' ? new GoogleAuthProvider() : undefined;
const githubProvider = typeof app !== 'undefined' ? new GithubAuthProvider() : undefined;

export { app, auth, googleProvider, githubProvider, analytics };
