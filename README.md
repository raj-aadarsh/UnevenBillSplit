# Uneven Bill Split

Scan a restaurant bill, tap who had what, and get each person's share. Taxes and service charge are split equally, and if you paid less than the bill (card or app offer), the discount is shared out fairly.

It's a free web app (PWA). Host it on GitHub Pages and add it to your phone's home screen. It works on iPhone, Android, iPad and tablets, and costs nothing to run.

## How it works

1. **Scan bill** (camera), or **From photos**, **Paste text**, or **Type items**.
2. **Check items.** Fix any misread name or amount. A green tick means the items match the bill's grand total.
3. **People.** Enter how many people and their names.
4. **Who had what.** Tap names on each item, or tap **Everyone**. Use **By person** to pick everything one person had.
5. **Amount paid.** Enter what you actually paid. The difference from the bill total (card, app or coupon discount) comes off each person in proportion to their share.
6. **The split.** Shows each person's amount with a full breakdown. **Share** sends it to WhatsApp.

### The maths

```
person items   = Σ item amount ÷ number of people on that item
tax share      = (all taxes + service charge + round-off) ÷ number of people
bill discount  = discount printed on bill, shared in proportion to items
before disc.   = items − bill discount share + tax share
final          = before disc. × (amount paid ÷ bill total)
```

Amounts are rounded to paise so that everyone's shares add up exactly to the total.

## Bill reading (all free)

| Mode | Accuracy | Needs |
|---|---|---|
| **AI (Google Gemini Flash-Lite, free tier)** | Best. Handles crumpled, angled or faded bills | Nothing for users. Built in through the shared reader below |
| **On this phone (Tesseract.js)** | Good on clear, straight photos | Nothing. Bundled in `vendor/` and works offline |
| **Paste text** | Very good | Copy the text with iPhone Live Text or Google Lens |

If the AI is busy, slow (over 40 s) or out of free quota, the app switches to on-device reading automatically.

### Shared AI reader (`worker/`)

A free Cloudflare Worker (`bill-split-reader`) holds the Gemini API key as an **encrypted secret**. The website sends the bill photo to the Worker and gets back only the item list. The key is never in this repo, never sent to the browser, and never echoed in error messages.

- Only requests from the website's origin are accepted (`ALLOWED_ORIGINS` in `worker/wrangler.toml`).
- Input is a photo only, with a fixed bill-reading prompt, so it can't be used as a general AI proxy.
- Photo size is capped, and each visitor is limited to 12 scans a minute.
- Flash-Lite is tried first. Flash is started as a backup if it's slow or busy, and both are retried once.
- **Never enable billing** on the Google project that owns the key. On the free tier it cannot cost money; abuse can at most use up the day's free quota.

Deploy or update it:

```bash
cd worker
npx wrangler@4.157.0 login     # once
npx wrangler@4.157.0 deploy
```

Set the key in the Cloudflare dashboard: **Workers & Pages → bill-split-reader → Settings → Variables and Secrets → Add**, type **Secret**, name `GEMINI_API_KEY`. The Worker's address goes in `js/config.js`.

## Put it online with GitHub Pages (free)

1. Create a new **public** repository on github.com, for example `bill-split`.
2. Upload everything in this folder. Either drag the files into the GitHub web page (**Add file → Upload files**), or use the terminal:
   ```bash
   git init && git add . && git commit -m "Bill Split"
   git branch -M main
   git remote add origin https://github.com/<your-username>/bill-split.git
   git push -u origin main
   ```
3. On GitHub, open **Settings → Pages**. Under **Source**, choose **Deploy from a branch**, then branch `main`, folder `/ (root)`, and click **Save**.
4. After about a minute the site is live at `https://<your-username>.github.io/bill-split/`.

## Install on your phone

- **iPhone / iPad:** open the link in **Safari**, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in **Chrome**, then tap **Install** in the app or use **⋮ → Add to Home screen**.

Then open it from the home screen and go to **Settings** to paste your free Gemini key (optional).

## Develop

```bash
npm test          # unit tests for the split maths and bill-text parser
npm start         # serves on http://localhost:8080
```

No build step. Plain HTML, CSS and JavaScript modules.

```
index.html, css/styles.css
js/app.js       screens and state
js/split.js     split calculation (pure, tested)
js/parser.js    bill text → items / taxes (tested)
js/ocr.js       shared AI reader + on-device OCR
js/gemini.js    Gemini request logic (used by the Worker)
js/config.js    address of the shared AI reader
worker/         Cloudflare Worker that holds the key
sw.js           offline cache
vendor/         Tesseract.js 7.0.0 (Apache-2.0) + English data
```

When you change files, bump `VERSION` in `sw.js`. Installed apps check for a new version every time they are opened and reload into it automatically.

**Privacy:** no split history is kept. The only things stored on the phone are the split currently in progress (deleted when you tap **New split**) and two settings.
