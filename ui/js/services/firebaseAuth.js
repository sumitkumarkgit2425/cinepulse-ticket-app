// ui/js/services/firebaseAuth.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDyFUxmrp9LhQFfKY1Yqf7LaY5dyeb-qx0",
  authDomain: "cinepulse-app-486c3.firebaseapp.com",
  projectId: "cinepulse-app-486c3",
  storageBucket: "cinepulse-app-486c3.firebasestorage.app",
  messagingSenderId: "517510650672",
  appId: "1:517510650672:web:b247445f38cca5d3e9c6f5"
};

export let app, auth, provider;

try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  setPersistence(auth, browserLocalPersistence);
  provider = new GoogleAuthProvider();
} catch (error) {
  console.warn("Firebase config is missing or invalid. Auth features will be disabled.");
}

/**
 * Listen to auth state changes
 * @param {Function} callback 
 */
export function listenToAuthChanges(callback) {
  if (!auth) return;
  onAuthStateChanged(auth, (user) => {
    callback(user);
  });
}

/**
 * Sign in with Google Popup
 */
export async function loginWithGoogle() {
  if (!auth) {
    alert("Firebase Auth is not configured. Please add your config in ui/js/services/firebaseAuth.js");
    return;
  }
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error("Google login failed:", error);
    throw error;
  }
}

export async function loginAsGuest() {
  if (!auth) return;
  try {
    const result = await signInAnonymously(auth);
    return result.user;
  } catch (error) {
    console.error("Guest login failed:", error);
    throw error;
  }
}

/**
 * Sign out the current user
 */
export async function logout() {
  if (!auth) return;
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed:", error);
  }
}
