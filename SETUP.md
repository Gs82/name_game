# Putting Roll Call online

The website lives in `docs/` and runs on GitHub Pages. Players join from your **invite link** with their school email, their name and a password, with no confirmation email. Only emails on your class list who have the class code can see the photos or play. Scores, settings and photos are stored in a free Firebase project. Setup takes about 15 minutes, costs nothing, and needs no credit card.

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
4. Replace `organizer@mit.edu` with **your @mit.edu email** (the one you'll sign up with), then click **Publish**. Only edit it here in the console. The repository is public, so don't commit your real email.

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

1. Open the site, click **Join the class**, and sign up with the email you put in the rules. Leave the class code empty. You'll see "not on the list". Click **I'm the organizer**, confirm the email Firebase sends (check **Junk**), and you'll get the organizer tools. You only do this once.
2. Under **Class list**, paste your classmates' school emails.
3. Click **Add class photos** and choose your photos folder. Filenames become names, for example `Jane_Doe.jpg` becomes "Jane Doe".
4. Set the prize and dates in **Challenge settings**. The week starts the first time you sign in as organizer.
5. Try a ranked run, then **Clear leaderboard**.
6. Under **Invite link**, click **Copy link** and send it to the class. The link fills in the class code, so classmates only type their email, name and a password. If the link leaks, **Make a new code**. People who already joined keep playing.

## How the pieces protect the class

- **Class list and class code:** only emails on your list can join, and only with the class code from your invite link. The rules check both on the server. Removing someone from the list locks them out even after they've joined.
- **No confirmation email for players**, so someone who knows the code could sign up with a listed classmate's email before that person does. The real person would then see "account already exists". Delete the impostor in Firebase under **Authentication**, then **Users**, and in the database under `members`. Passwords stop anyone from taking over an account once it's claimed.
- **Organizer tools:** only your email can upload photos, change the list or settings, or clear the leaderboard. Your email lives only in the Firestore rules, never in the public site code.
- **Scores:** each player can only write their own score. The rules reject scores outside the challenge window, totals that don't match the class size, and times faster than 0.25 seconds per photo.
- **Search engines** are asked not to index the site.
- **Names on the leaderboard** are what players typed when they created their account. You can see who's who from the class list.

The scoring still runs in each player's browser, so a determined, technical player could submit a fake result that passes those checks. For a prize it's worth having the winner do one run in front of you.

## Free-tier limits

- **Emails:** only the organizer's one-time confirmation and password resets. Firebase's free plan sends up to 1,000 confirmations a day.
- **Database reads:** 50,000 a day. Each page load reads about one document per classmate, so a class of 40 can load the site about 1,000 times a day.

Both are far more than a class needs.
