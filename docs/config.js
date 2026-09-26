// Firebase settings for Roll Call. These values are not secret: the security
// rules in firestore.rules decide who can read and write.
// Replace the placeholders with the config from Firebase: Project settings → Your apps → Web app.
export const FIREBASE_CONFIG = {
  apiKey: 'PASTE_API_KEY',
  authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
  projectId: 'PASTE_PROJECT_ID',
  appId: 'PASTE_APP_ID',
};

// Only addresses at this domain can sign up or be added to the class list.
export const EMAIL_DOMAIN = 'mit.edu';

// Organizer emails are NOT listed here (this file is public). They live only in
// the Firestore security rules, which you paste into the Firebase console.
