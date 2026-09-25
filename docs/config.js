// Firebase settings for Roll Call. These values are not secret: the security
// rules in firestore.rules decide who can read and write.
// Replace the placeholders with the config from Firebase: Project settings → Your apps → Web app.
export const FIREBASE_CONFIG = {
  apiKey: 'PASTE_API_KEY',
  authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
  projectId: 'PASTE_PROJECT_ID',
  appId: 'PASTE_APP_ID',
};

// Google accounts that can upload photos and change settings.
// Must match the list in firestore.rules.
export const ORGANIZER_EMAILS = ['organizer@example.com'];
