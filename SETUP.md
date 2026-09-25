# Putting Roll Call online

The website lives in `docs/` and runs on GitHub Pages. Scores, settings and the (encrypted) class photos are stored in a free Firebase project. Setup takes about 15 minutes and costs nothing.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with the Google account you'll use as the organizer.
2. Click **Create a project**, name it (for example `roll-call`), and turn off Google Analytics. It isn't needed.

## 2. Turn on Google sign-in

1. In the left menu open **Build → Authentication** and click **Get started**.
2. Under **Sign-in method**, choose **Google**, switch it on, pick your support email, and **Save**.
3. Open the **Settings** tab → **Authorized domains** → **Add domain** and enter `gs82.github.io`.

## 3. Create the database

1. Open **Build → Firestore Database** → **Create database**.
2. Pick a location near you and start in **production mode**.
3. Open the **Rules** tab, delete what's there, and paste the contents of [`firestore.rules`](firestore.rules).
4. Replace `organizer@example.com` with your Google email, then click **Publish**.

## 4. Connect the website

1. Click the gear icon → **Project settings** → **Your apps** → the web icon `</>`.
2. Register an app (any nickname, leave Firebase Hosting unticked).
3. Copy the values from the `firebaseConfig` it shows into [`docs/config.js`](docs/config.js), and put your Google email in `ORGANIZER_EMAILS`.

These values aren't secret. The rules from step 3 decide who can do what.

## 5. Publish the site

1. In the GitHub repository open **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick **main** and **/docs**, and **Save**.
3. After a minute or two the site is live at <https://gs82.github.io/name_game/>.

## 6. Run the challenge

1. Open the site, sign in with your organizer account, and choose a **class passcode**.
2. Click **Add class photos** and choose your photos folder. Filenames become names, for example `Jane_Doe.jpg` becomes "Jane Doe".
3. Set the prize and dates in **Challenge settings**. The week starts when you set the passcode.
4. Try a ranked run, then **Clear leaderboard**.
5. Send classmates the link **and** the passcode.

## How the pieces protect the class

- **Photos and names** are encrypted in your browser with a key made from the passcode (AES-256 with a PBKDF2-derived key). The database only stores scrambled data, so without the passcode it's useless.
- **Only organizer emails** can upload photos, change settings or clear the leaderboard. The Firestore rules enforce this, not just the page.
- **Scores:** each player can only write their own score, under their own Google name. The rules reject scores outside the challenge window, totals that don't match the class size, and times faster than 0.25 seconds per photo.
- **Search engines** are asked not to index the site.

The scoring still runs in each player's browser, so a determined, technical player could submit a fake result that passes those checks. For a prize it's worth having the winner do one run in front of you.

## Free-tier limits

Firebase's free plan allows 50,000 document reads a day. Each page load reads about one document per classmate, so a class of 40 can load the site about 1,000 times a day. That's plenty for a week-long challenge.
