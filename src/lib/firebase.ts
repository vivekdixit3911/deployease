
// src/lib/firebase.ts
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { getAnalytics, Analytics } from "firebase/analytics";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBlzmOXM8QzXrT-kWdSNH2jmKtcxuk7Y1c",
  authDomain: "deeps-e3fe9.firebaseapp.com",
  projectId: "deeps-e3fe9",
  storageBucket: "deeps-e3fe9.appspot.com", // Ensure this is the correct bucket name (usually project-id.appspot.com)
  messagingSenderId: "575487461961",
  appId: "1:575487461961:web:6e7375597a671da4ed4d98",
  measurementId: "G-F37LTB2835"
};

let app: FirebaseApp;
let analytics: Analytics | undefined;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
  // Check if window is defined (i.e., we are on the client-side) before initializing Analytics
  if (typeof window !== 'undefined') {
    analytics = getAnalytics(app);
  }
} else {
  app = getApps()[0];
  // If app already initialized, try to get analytics instance if on client
  if (typeof window !== 'undefined') {
    try {
        analytics = getAnalytics(app);
    } catch (e) {
        console.warn("Could not initialize Firebase Analytics on subsequent app instance:", e);
    }
  }
}

const storage: FirebaseStorage = getStorage(app);

export { app, storage, analytics };
