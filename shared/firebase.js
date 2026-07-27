// Shared Firebase init for host + player apps. No build step — imported
// directly as an ES module, loaded via the gstatic CDN.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

// Safe to keep in the client bundle: Firebase web app config is not a
// secret, unlike a normal API key. Access control is enforced by
// Firestore security rules (see /firestore.rules), not by hiding this.
const firebaseConfig = {
  apiKey: "AIzaSyCu3qnt2-8zsyxqCKjnxPU3yTN-JDXUtm4",
  authDomain: "film-geek.firebaseapp.com",
  projectId: "film-geek",
  storageBucket: "film-geek.firebasestorage.app",
  messagingSenderId: "62720648922",
  appId: "1:62720648922:web:9c2f52e30b1d757a42a7e3",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Resolves once a user (anonymous is fine) is signed in. Both host and
// player pages await this before touching Firestore, so security rules
// always have a request.auth.uid to check against.
export const authReady = new Promise((resolve, reject) => {
  const unsubscribe = onAuthStateChanged(
    auth,
    (user) => {
      if (user) {
        unsubscribe();
        resolve(user);
      } else {
        signInAnonymously(auth).catch(reject);
      }
    },
    reject
  );
});
