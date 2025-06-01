// src/lib/firebase.ts
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider } from 'firebase/auth';
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics'; // For Firebase Analytics

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDHKW4sPBve6vVcqsVMVYffdje040tjGyQ",
  authDomain: "deployease-8y1kj.firebaseapp.com",
  projectId: "deployease-8y1kj",
  storageBucket: "deployease-8y1kj.firebasestorage.app",
  messagingSenderId: "627224392163",
  appId: "1:627224392163:web:dfd3dba99499f6ed6930d6"
  // measurementId is optional and not provided in the new config
};

let app: FirebaseApp;
let analytics: Analytics | undefined;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

// Initialize Analytics if supported
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
    console.log("Firebase Analytics initialized with new config.");
  } else {
    console.log("Firebase Analytics is not supported in this environment.");
  }
});


const auth = getAuth(app);
// const db = getFirestore(app); // For later use

const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

export { app, auth, googleProvider, githubProvider, analytics /*, db */ };
