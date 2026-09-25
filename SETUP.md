# Putting Roll Call online

The website lives in `docs/` and runs on GitHub Pages. Players sign in with their **school email and a password**. Only emails on your class list can see the photos or play. Scores, settings and photos are stored in a free Firebase project. Setup takes about 15 minutes, costs nothing, and needs no credit card.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with any Google account. This is only for managing the project. Players never see it.
2. Click **Create a project**, name it (for example `roll-call`), and turn off Google Analytics. It isn't needed.

## 2. Turn on email sign-in

1. In the left menu open **Build → Authentication** and click **Get started**.
2. On the **Sign-in method** tab, click **Email/Password**. Switch on the first toggle (**Email/Password**), leave **Email link** off, and click **Save**. No support email is needed.
3. Open the **Settings** tab → **Authorized domains** → **Add domain** and enter `gs82.github.io`.
4. Optional: on the **Templates** tab, open **Email address verification** and change the sender name to something classmates will recognize, like "Roll Call".

## 3. Create the database

1. Open **Build → Firestore Database** → **Create database**.
2. Pick a location near you and start in **production mode**.
3. Open the **Rules** tab, delete what's there, and paste the contents of [`firestore.rules`](firestore.rules).
4. Replace `organizer@school.edu` with **your school email**, then click **Publish**. Only edit it here in the console. The repository is public, so don't commit your real email.

## 4. Connect the website

1. Click the gear icon → **Project settings** → **Your apps** → the web icon `</>`.
2. Register an app (any nickname, leave Firebase Hosting unticked).
3. Copy the values from the `firebaseConfig` it shows into [`docs/config.js`](docs/config.js).

These values aren't secret. The rules from step 3 decide who can do what.

## 5. Publish the site

1. In the GitHub repository open **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick **main** and **/docs**, and **Save**.
3. After a minute or two the site is live at <https://gs82.github.io/name_game/>.

## 6. Run the challenge

1. Open the site and click **Create an account** with your school email. Confirm it from the email Firebase sends, and check **Junk**. You'll then see the organizer tools.
2. Under **Class list**, paste your classmates' school emails.
3. Click **Add class photos** and choose your photos folder. Filenames become names, for example `Jane_Doe.jpg` becomes "Jane Doe".
4. Set the prize and dates in **Challenge settings**. The week starts the first time you sign in as organizer.
5. Try a ranked run, then **Clear leaderboard**.
6. Send classmates the link. Tell them to create an account with their school email, and to check Junk for the confirmation email.

## How the pieces protect the class

- **Class list:** only emails on your list can see the photos, the leaderboard or the settings. Players must confirm they own the address by clicking the link in their inbox.
- **Organizer tools:** only your email can upload photos, change the list or settings, or clear the leaderboard. Your email lives only in the Firestore rules, never in the public site code.
- **Scores:** each player can only write their own score. The rules reject scores outside the challenge window, totals that don't match the class size, and times faster than 0.25 seconds per photo.
- **Search engines** are asked not to index the site.
- **Names on the leaderboard** are what players typed when they created their account. You can see who's who from the class list.

The scoring still runs in each player's browser, so a determined, technical player could submit a fake result that passes those checks. For a prize it's worth having the winner do one run in front of you.

## Free-tier limits

- **Confirmation emails:** Firebase's free plan sends up to 1,000 a day.
- **Database reads:** 50,000 a day. Each page load reads about one document per classmate, so a class of 40 can load the site about 1,000 times a day.

Both are far more than a class needs.
