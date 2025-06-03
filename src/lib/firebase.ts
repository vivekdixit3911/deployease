
// src/lib/firebase.ts
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider } from 'firebase/auth';
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics';
import { getFirestore, initializeFirestore, CACHE_SIZE_UNLIMITED } from 'firebase/firestore'; // Added Firestore imports

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
let db: ReturnType<typeof getFirestore> | undefined; // Firestore instance

console.log(`[Firebase Setup Attempt] Using config - Project ID: ${firebaseConfig.projectId}, Auth Domain: ${firebaseConfig.authDomain}`);

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  console.error("CRITICAL: Firebase configuration (apiKey or projectId) is missing. Ensure NEXT_PUBLIC_FIREBASE_* environment variables are set.");
}

if (!getApps().length) {
  if (firebaseConfig.apiKey && firebaseConfig.projectId) {
    try {
      app = initializeApp(firebaseConfig);
      console.log(`[Firebase Setup] Successfully Initialized NEW Firebase app with projectId: ${firebaseConfig.projectId}, authDomain: ${firebaseConfig.authDomain}`);
      // Initialize Firestore
      // db = getFirestore(app); // Standard initialization
      // Experimental memory persistence, useful if offline capabilities become a focus
      db = initializeFirestore(app, {
        cacheSizeBytes: CACHE_SIZE_UNLIMITED // Example: enable offline persistence with unlimited cache
      });
      console.log("[Firebase Setup] Firestore initialized.");

    } catch (e) {
        console.error("[Firebase Setup] Error initializing Firebase app or Firestore:", e);
    }
  } else {
    console.error("[Firebase Setup] Cannot initialize Firebase: API key or Project ID is missing from environment variables.");
  }
} else {
  app = getApps()[0];
  if (app.options.projectId !== firebaseConfig.projectId && firebaseConfig.apiKey && firebaseConfig.projectId) {
    console.warn(`[Firebase Setup] Mismatch! Existing app projectId (${app.options.projectId}) does not match new config projectId (${firebaseConfig.projectId}). Attempting to initialize a new app with a unique name if possible.`);
    try {
        // Attempt to initialize with a unique name to avoid conflicts if strictly necessary
        app = initializeApp(firebaseConfig, `app-${Date.now()}`); 
        console.log(`[Firebase Setup] Successfully Initialized secondary Firebase app instance for projectId: ${firebaseConfig.projectId}`);
         db = getFirestore(app);
         console.log("[Firebase Setup] Firestore initialized for secondary app instance.");
    } catch(e) {
        console.error(`[Firebase Setup] Failed to initialize a secondary app. Using the existing one despite projectId mismatch. This may lead to issues. Error:`, e);
        // Fallback to using the first app's Firestore if secondary init fails
        if (getApps()[0]) {
          db = getFirestore(getApps()[0]);
          console.log("[Firebase Setup] Firestore initialized using original app instance due to secondary init failure.");
        }
    }

  } else if (app.options.projectId === firebaseConfig.projectId) {
     console.log(`[Firebase Setup] Successfully Used EXISTING Firebase app instance for projectId: ${app!.options.projectId}, authDomain: ${app!.options.authDomain}`);
     db = getFirestore(app);
     console.log("[Firebase Setup] Firestore initialized for existing app instance.");
  } else {
    console.error("[Firebase Setup] Existing app found, but new config is incomplete. Cannot determine Firestore instance reliably.");
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

const auth = typeof app !== 'undefined' ? getAuth(app) : undefined;
const googleProvider = typeof app !== 'undefined' ? new GoogleAuthProvider() : undefined;
const githubProvider = typeof app !== 'undefined' ? new GithubAuthProvider() : undefined;

export { app, auth, googleProvider, githubProvider, analytics, db }; // Export db
