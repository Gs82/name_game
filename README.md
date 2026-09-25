# name_game

A game for learning classmates' names from their photos.

## Roll Call website (`docs/`)

The week-long challenge as a public website: <https://gs82.github.io/name_game/> once GitHub Pages is on. **See [SETUP.md](SETUP.md) to connect Firebase and publish it.**

- **Ranked run:** every classmate appears once, with four name options each. Most correct wins, and ties go to the faster time. Each correct answer climbs from Base Camp toward the Everest summit, with confetti, shaking and thinning air as players get higher. Only a player's best run counts.
- **Practice:** multiple choice, type-the-name, or flashcards. Not timed or recorded.
- **Players** sign in with their school email and a password. Only emails on the organizer's class list can get in.
- **The organizer** pastes in the class list, uploads the photo folder, fixes names, sets the dates and prize, and clears the leaderboard.

| File | What it is |
| --- | --- |
| `docs/index.html` | Page layout and styles |
| `docs/app.js` | Game, sign-in, and Firebase code |
| `docs/config.js` | Your Firebase settings |
| `firestore.rules` | Database security rules (paste into Firebase) |

## Other versions

- `roll-call.html`: the same challenge built as a claude.ai page, for classes that all share one claude.ai organization.
- `index.html`: an offline practice version. Open it in a browser and choose a photos folder. Nothing is uploaded and there's no leaderboard.
