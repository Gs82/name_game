# name_game

A game for learning classmates' names from their photos.

## Roll Call: the week-long challenge (`roll-call.html`)

Published as a claude.ai page with a shared leaderboard.

- **Ranked run:** every classmate appears once, with four name options each. Most correct wins, and ties go to the faster time. The clock only runs while a photo waits for an answer. Players can play as often as they like; only their best run counts.
- **Practice:** multiple choice, type-the-name, or flashcards. Not timed or recorded.
- **Organizer panel** (editors only): upload a folder of photos (the filename becomes the name, e.g. `Jane_Doe.jpg` → "Jane Doe"), fix names, remove people, set the start/end time and prize, and clear the leaderboard.

Data lives in the page's database:

| Path | Contents | Who can write |
| --- | --- | --- |
| `roster/<id>` | `{name, asset}` (photo asset id) | organizer |
| `config/challenge` | `{startsAt, endsAt, prize}` (ms timestamps) | organizer |
| `scores/<userId>` | `{correct, total, ms, achievedAt, attempts}` best run | that player |

Players need **Contributor** access to save scores. Viewers can practice but their runs aren't recorded.

## Offline practice (`index.html`)

A standalone version that runs from your own computer. Open `index.html` in a browser and choose your photos folder. Nothing is uploaded and there's no leaderboard.
