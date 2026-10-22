# StudyBlue 📘

A small flashcard website inspired by the old StudyBlue, with its interface in Dutch. All study material comes
from JSON files in the [`lessons/`](lessons) folder: add a file on GitHub and it shows up in the app.

- **Kaarten (flashcards)**: tap to flip, then mark *Wist ik!* or *Wist ik niet*. Arrow keys and swiping also work.
- **Meerkeuze (multiple choice)**: the wrong answers are taken from the other cards.
- **Typen (typing)**: type the answer. Letters that differ from the correct answer are highlighted. "de"/"het" and text in brackets are optional.
- **Spelling lessons**: the word is read aloud and your child types it. A sentence with the word can also be read aloud.
- **Read aloud 🔊**: on every card. It uses the device's built-in voices, preferring a Flemish one (`nl-BE`).
- Results screen with stars, confetti and a score chart, plus **Practise missed cards**.
- **Lesson pages**: every card with times played, right vs wrong, % right and the last 10 results. You can sort and filter the list.
- **Mijn voortgang (📊)**: day streak, study calendar, last 2 weeks, lesson mastery, trickiest cards, and progress backup and restore.
- **✏️ Les maken (lesson maker)**: type cards as simple lines and try them out. Then copy the lesson to GitHub, or open an existing lesson to edit it.
- **Works as an iPhone/iPad app**, including offline.

## Install on iPhone or iPad

1. Open the site in **Safari**.
2. Tap **Share** (the square with the arrow), then **Add to Home Screen**.
3. StudyBlue now opens full screen from its own icon. It also works without internet, using the lessons it last loaded.

For better read-aloud quality, download a better Dutch voice on the iPhone. Go to **Settings › Accessibility › Spoken Content › Voices › Dutch**. Pick e.g. *Ellen* (Flemish), preferably the *Enhanced* version.

## Making a lesson

The easiest way is **✏️ Les maken** on the home screen. Type one card per line, tap **📋 Kopieer tekst**,
then **🐙 Zet op GitHub**. Paste the text and tap **Commit changes**. About a minute later the lesson appears in the app.

Card lessons use `front = back`, with an optional `| hint`:

```
de eikel = de vrucht van de eik
het beukenblad = ovaal en glad blad | denk aan de beuk
```

Spelling lessons take one word per line, with an optional `| sentence to read aloud`:

```
eikel | De eekhoorn eet een eikel.
kastanje
```

## The lesson file format

```json
{
  "project": "Wero",                    // groups lessons together on the home page
  "name": "Herfst",                     // lesson title
  "description": "Woordenschat",        // optional
  "icon": "🍂",                          // optional emoji
  "color": "#FE9934",                   // optional accent colour
  "language": "nl-BE",                  // optional, voice used for reading aloud (default nl-BE)
  "order": 1,                           // optional, sorts lessons inside a project
  "cards": [
    {
      "front": "De eikel",
      "back": "De vrucht van de eik.",
      "hint": "Denk aan de eekhoorn",      // optional, shown on request
      "image": "images/eikel.jpg",         // optional picture on the front
      "backImage": "images/eik.jpg",       // optional picture on the back
      "audio": "audio/eikel.mp3",          // optional own recording instead of the voice
      "say": "de eikel",                   // optional, text to read aloud if it differs from the front
      "wrong": ["De vrucht van de beuk"]   // optional: multiple choice then uses only these wrong answers
    }
  ]
}
```

A spelling lesson has `"type": "spelling"`, and its cards are words:

```json
{
  "project": "Wero",
  "name": "Herfst — spelling",
  "type": "spelling",
  "cards": [
    { "word": "eikel", "say": "de eikel", "sentence": "De eekhoorn eet een eikel." },
    { "word": "kastanje" }
  ]
}
```

(Real JSON can't contain the `// comments` above. Leave them out of your files.)

Some shortcuts:

- You can write a card as a pair: `["7 × 8", "56"]`.
- `materials`, `flashcards` or `questions` work in place of `cards`. `question`/`answer` and `term`/`definition` work in place of `front`/`back`.
- One file can hold several lessons. Use a `"lessons": [ {...}, {...} ]` list, and put `project`, `icon` and `color` at the top so every lesson shares them.
- Image and audio paths are relative to the JSON file, so `images/x.png` means `lessons/images/x.png`. A full `https://` URL also works.

If a file has a typo, the home page shows a red box that names the file and the problem. The other lessons keep working.

## Putting it online (GitHub Pages)

1. In the repository, go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
2. Every push to `master` (or `main`) runs *Deploy StudyBlue*. It rebuilds the lesson list and publishes the site to
   `https://<your-username>.github.io/<repo-name>/`.

The repository name and branch the lesson maker links to are set at the top of [`app.js`](app.js) (`githubRepo`, `githubBranch`).

## Trying it on your computer

The browser can't load the JSON files from a double-clicked `index.html`, so start a small local server instead:

```bash
python -m http.server 8765
```

Then open http://localhost:8765. After adding or renaming lesson files locally, refresh the lesson list:

```bash
node tools/build-index.mjs
```

The app icons are drawn by `python tools/make-icons.py`, which needs Pillow.

## Personalising

At the top of [`app.js`](app.js), set `studentName: 'Emma'` (or any name) to greet your child by name on the home screen.

Progress is stored on each device (in the browser or the installed app), so a laptop and an iPhone each keep their own
stars and streaks. Use the backup on the 📊 page to move progress between them.
