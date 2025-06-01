// src/lib/firebase.ts
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider } from 'firebase/auth';
import { getAnalytics, isSupported } from 'firebase/analytics'; // For Firebase Analytics

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBlzmOXM8QzXrT-kWdSNH2jmKtcxuk7Y1c",
  authDomain: "deeps-e3fe9.firebaseapp.com",
  projectId: "deeps-e3fe9",
  storageBucket: "deeps-e3fe9.appspot.com", // Standard format for SDK
  messagingSenderId: "575487461961",
  appId: "1:575487461961:web:6e7375597a671da4ed4d98",
  measurementId: "G-F37LTB2835"
};

let app: FirebaseApp;
let analytics;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

// Initialize Analytics if supported
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
    console.log("Firebase Analytics initialized.");
  } else {
    console.log("Firebase Analytics is not supported in this environment.");
  }
});


const auth = getAuth(app);
// const db = getFirestore(app); // For later use

const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

export { app, auth, googleProvider, githubProvider, analytics /*, db */ };
