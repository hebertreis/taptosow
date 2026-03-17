// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBGrwD_wZoxU5T51zDKbiI_L92SJFElBNI",
  authDomain: "taptosow-staging.firebaseapp.com",
  databaseURL: "https://taptosow-staging-default-rtdb.firebaseio.com",
  projectId: "taptosow-staging",
  storageBucket: "taptosow-staging.firebasestorage.app",
  messagingSenderId: "824431235738",
  appId: "1:824431235738:web:212eae39dfb4d795808523",
  measurementId: "G-Z3FWSBEZ97"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);