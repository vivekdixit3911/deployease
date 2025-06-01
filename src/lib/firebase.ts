// src/lib/firebase.ts
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider } from 'firebase/auth';
// import { getFirestore } from 'firebase/firestore'; // For later use with user project data

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID, // Optional
};

let app: FirebaseApp;

if (!getApps().length) {
  if (firebaseConfig.apiKey && firebaseConfig.projectId) {
    app = initializeApp(firebaseConfig);
  } else {
    console.warn(
      'Firebase config (apiKey or projectId) is missing. Firebase App not initialized. Ensure .env file is populated with NEXT_PUBLIC_FIREBASE_... variables.'
    );
    // Fallback or throw error if Firebase is critical and not configured
    // For now, we'll let it proceed, but auth features won't work.
    // @ts-ignore // Allow app to be potentially uninitialized if config is missing
    app = undefined; 
  }
} else {
  app = getApps()[0];
}

const auth = getAuth(app);
// const db = getFirestore(app); // For later use

const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

export { app, auth, googleProvider, githubProvider /*, db */ };
