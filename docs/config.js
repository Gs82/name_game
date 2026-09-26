// Firebase settings for Roll Call. These values are not secret: the security
// rules in firestore.rules decide who can read and write.
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCH3QK0IMeIxnfZP-cVpVF9KmjGwDTxNMI',
  authDomain: 'namegame-e709f.firebaseapp.com',
  projectId: 'namegame-e709f',
  storageBucket: 'namegame-e709f.firebasestorage.app',
  messagingSenderId: '166388829920',
  appId: '1:166388829920:web:421f896dbb745f8b1d0a85',
};

// Only addresses at this domain can sign up or be added to the class list.
export const EMAIL_DOMAIN = 'mit.edu';

// Organizer emails are NOT listed here (this file is public). They live only in
// the Firestore security rules, which you paste into the Firebase console.
