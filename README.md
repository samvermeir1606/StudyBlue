# StudyBlue 📘

A small flashcard website inspired by the old StudyBlue. All study material comes from
JSON files in the [`lessons/`](lessons) folder: drop in a new file, push it to GitHub, and it
shows up on the site.

- **Flashcards**: tap to flip, then mark *Knew it* or *Didn't know*. Arrow keys and swiping also work.
- **Quiz**: multiple choice, with the wrong answers taken from the other cards.
- Right and wrong counts while you study, plus a results screen with stars, confetti, a score chart and your last tries.
- **Practise missed cards**: repeat only the cards you got wrong.
- Saves progress in the browser: best score, how well each lesson is known, a daily streak 🔥 and a star counter ⭐.

## Adding a lesson

Make a new `.json` file in `lessons/` (subfolders are fine). Here is a minimal one:

```json
{
  "project": "Science",
  "name": "The Water Cycle",
  "cards": [
    { "front": "Evaporation", "back": "Water turns into vapour" },
    { "front": "Condensation", "back": "Vapour turns into clouds" }
  ]
}
```

And here is one that uses every field:

```json
{
  "project": "Science",                 // groups lessons together on the home page
  "name": "The Water Cycle",            // lesson title
  "description": "Short subtitle",      // optional
  "icon": "💧",                          // optional emoji
  "color": "#1f9be0",                   // optional accent colour
  "order": 1,                           // optional, sorts lessons inside a project
  "cards": [
    {
      "front": "Evaporation",
      "back": "Water turns into vapour",
      "hint": "Think of a puddle on a sunny day",          // optional, shown on request
      "image": "images/sun.png",                            // optional picture on the front
      "backImage": "images/vapour.png",                     // optional picture on the back
      "wrong": ["Water freezes", "Water falls as rain"]     // optional wrong answers for the quiz
    }
  ]
}
```

(Real JSON can't contain the `// comments` above. Leave them out of your files.)

Some shortcuts:

- You can write a card as a pair: `["7 × 8", "56"]`.
- `materials`, `flashcards` or `questions` work in place of `cards`. `question`/`answer` and `term`/`definition` work in place of `front`/`back`.
- One file can hold several lessons. Use a `"lessons": [ {...}, {...} ]` list, and put `project`, `icon` and `color` at the top so every lesson shares them. See [`lessons/languages-french.json`](lessons/languages-french.json).
- Image paths are relative to the JSON file, so `images/x.png` means `lessons/images/x.png`. A full `https://` URL also works.

If a file has a typo, the home page shows a red box that names the file and the problem. The other lessons keep working.

## Putting it online (GitHub Pages)

1. Create a new repository on GitHub and upload all of these files (or push them with git).
2. In the repository, go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab and wait for *Deploy StudyBlue* to turn green. The site is now at
   `https://<your-username>.github.io/<repo-name>/`.

From then on, uploading a new lesson file is all you need to do. On github.com, open the `lessons` folder, choose
**Add file → Upload files** (or **Create new file**), and commit. The Action rebuilds the lesson list and
republishes the site within about a minute.

## Trying it on your computer

The browser can't load the JSON files from a double-clicked `index.html`, so start a small local server instead:

```bash
python -m http.server 8765
```

Then open http://localhost:8765. After adding or renaming lesson files locally, refresh the lesson list:

```bash
node tools/build-index.mjs
```

## Personalising

At the top of [`app.js`](app.js), set `studentName: 'Emma'` (or any name) to greet your child by name on the home screen.

Progress is stored in the browser on each device (localStorage), so a laptop and a tablet each keep their own stars and streaks.
