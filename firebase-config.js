const firebaseConfig = {
  apiKey: "AIzaSyCJm1WW7M58yG55bGy5Ba-934GonQV5ZFA",
  authDomain: "new-gms-haripura-59f06.firebaseapp.com",
  projectId: "new-gms-haripura-59f06",
  storageBucket: "new-gms-haripura-59f06.firebasestorage.app",
  messagingSenderId: "845375890121",
  appId: "1:845375890121:web:58578355d1f9db6636e318"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
