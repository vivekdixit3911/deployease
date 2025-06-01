// src/lib/firebase.ts
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider } from 'firebase/auth';
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics'; // For Firebase Analytics

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDHKW4sPBve6vVcqsVMVYffdje040tjGyQ",
  authDomain: "deployease-8y1kj.firebaseapp.com",
  projectId: "deployease-8y1kj",
  storageBucket: "deployease-8y1kj.firebasestorage.app",
  messagingSenderId: "627224392163",
  appId: "1:627224392163:web:dfd3dba99499f6ed6930d6"
  // measurementId is optional
};

let app: FirebaseApp;
let analytics: Analytics | undefined;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
  console.log(`[Firebase Setup] Initializing Firebase app with projectId: ${firebaseConfig.projectId}, authDomain: ${firebaseConfig.authDomain}`);
} else {
  app = getApps()[0];
  console.log(`[Firebase Setup] Using existing Firebase app instance for projectId: ${app.options.projectId}, authDomain: ${app.options.authDomain}`);
}

// Initialize Analytics if supported
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


const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

export { app, auth, googleProvider, githubProvider, analytics };
