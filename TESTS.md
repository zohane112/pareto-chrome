# Tests

The user's test: on a long Wikipedia article, 10 plain-English questions should jump to the right paragraph at least 8 times, with a median under 1 second from Enter to highlight. The questions, the accepted paragraphs, and what counts as a hit are defined in [tests/test-set.md](tests/test-set.md).

## Nemotron, v1.6.0 (2026-10-27): passed against a stand-in Nebius

Version 1.6.0 adds NVIDIA Nemotron on Nebius Token Factory (see the README). These checks ran before a Nebius key existed, so every Nemotron call went to a stand-in server on this computer ([`tests/mock-tokenfactory.mjs`](tests/mock-tokenfactory.mjs)) that answers the way each model would. They prove the wiring, not Nemotron's accuracy or speed. [`tests/nemotron-live.mjs`](tests/nemotron-live.mjs) checks those with a real key.

| Check | Result |
| --- | --- |
| [`tests/nemotron-check.mjs`](tests/nemotron-check.mjs): the Nemotron code with no browser, no network and no key | 64 of 64 |
| [`tests/nemotron-chrome-check.mjs`](tests/nemotron-chrome-check.mjs): the real extension in hidden Chrome against the stand-in | 21 of 21 |
| [`tests/provider-check.mjs`](tests/provider-check.mjs): the AI providers, updated for Nemotron as the default | 91 of 91 |
| [`tests/launch-check.mjs`](tests/launch-check.mjs): opening the box, typing, the free plan | box in 4 ms through the shortcut, 3 ms from the page; all passed |

What the Chrome run covers:

- With only a Nebius key, Enter has Lightning find the paragraph, Lightning pick the sentence, and Nemotron 3 Super write the answer, all with reasoning off. The status line says `Lightning`.
- ⌘ Enter streams Ultra's reply with reasoning on. The answer panel shows `thinking · N words` while it streams, then the answer and how much Ultra thought. The lines Ultra used are highlighted, and ↓ steps between them.
- Option+Enter runs compare mode against Lightning.
- A Nebius refusal for lack of credit says so, and doesn't blame Jev.
- A Jev key that Jev refuses (one free call to the real Jev with a made-up key) hands the search to Lightning, and the status line says `Jev key refused`.
- In settings, the Nebius card shows the key is saved, answers default to Nemotron, and **Check the key** lists Lightning ✓ Super ✓ Ultra ✓.

## Latest result, v1.3.0: passed

| | Goal | v1.3.0 (2026-09-28) | v1.0.0 (2026-09-24) |
| --- | --- | --- | --- |
| Hits | at least 8 of 10 | **10 of 10** | 10 of 10 |
| Median, Enter to highlight | under 1,000 ms | **227 ms** | 359 ms |
| Slowest | written down, doesn't count | 246 ms | 446 ms |
| Shortcut to box on screen | as fast as normal Ctrl+F | **6 ms** | 69 ms |

- **v1.2.0 run:** 2026-09-28, by Claude, with [`tests/chrome-check.mjs`](tests/chrome-check.mjs) and [`tests/launch-check.mjs`](tests/launch-check.mjs), in the same hidden, throwaway Chrome with the real Jev key and the real AI bridge. Every paragraph, sentence and "Not found" matched the v1.0.0 run below. v1.2.0 is v1.1.0 in the terminal look, and it's loaded as soon as a page starts loading. An earlier v1.1.0 run the same day had a median of 217 ms.
- **Opening the box** (`launch-check.mjs`, no Jev calls): the median of 5 opens on the test page, with the background worker already awake.
  - Through the shortcut: 6 ms. v1.0.0 took 69 ms, because it loaded 6 files into the page and read the whole page before the box appeared.
  - Control+Shift+F caught by the page itself, for when Chrome doesn't pass the shortcut on: 2 ms. v1.0.0 did nothing in that case.
  - A tab that was open before the extension was reloaded: 51 ms, because the files are loaded on the first press. v1.0.0 took 70 ms.
- **Also checked by `launch-check.mjs`:**
  - Typing "Kasparov" lights up both matches before Enter.
  - On the free plan, Enter steps to the next word match, and the background worker refuses to ask Jev.

## Other kinds of site (v1.3.0, 2026-09-28)

[`tests/sites-check.mjs`](tests/sites-check.mjs) runs the real extension on 9 kinds of site in hidden Chrome. On each it opens the box, checks the page was read, types a word (it must light up before Enter), and asks one question with real Jev. It also fails on any error thrown by the extension's own scripts.

| Site | Read | Question | Jumped to | Time |
| --- | --- | --- | --- | --- |
| MDN, "Using HTTP cookies" | 87 chunks | how do I stop javascript from reading a cookie | "A cookie with the HttpOnly attribute can't be accessed by JavaScript…" | 150 ms |
| Wikipedia, "Python" | 203 chunks | who created python | the infobox row "Designed by · Guido van Rossum" | 174 ms |
| GitHub, microsoft/vscode | 68 chunks | how do I contribute | "If you are interested in fixing issues and contributing directly…" | 102 ms |
| Google Terms of Service | 142 chunks | can they suspend my account | "Google may suspend or terminate your access to the services…" | 126 ms |
| Python docs, control flow | 186 chunks | how do I loop over a sequence of numbers | "…the built-in function range() comes in handy." | 141 ms |
| gov.uk, renew a driving licence | 46 chunks | how much does it cost to renew | "It costs £14 when you apply online." | 93 ms |
| Apple, MacBook Air | 107 chunks | how long does the battery last | "Up to 18 hours of battery life." | 112 ms |
| Hacker News | 62 chunks | (words only) | | |
| BBC News | 28 chunks | (words only) | | |

All 9 opened, read, and lit up words as typed. All 7 questions went to the right place, and the extension threw no errors. Screenshots are in [`docs/sites/`](docs/sites/).

The rest of this page is the v1.0.0 run from 2026-09-24, kept for comparison.

## Result, v1.0.0: passed

| | Goal | Result |
| --- | --- | --- |
| Hits | at least 8 of 10 | **10 of 10** |
| Median, Enter to highlight | under 1,000 ms | **359 ms** |
| Slowest | written down, doesn't count | 446 ms |

- **Run:** 2026-09-24, by Claude, with [`tests/chrome-check.mjs`](tests/chrome-check.mjs).
- **Setup:** the finished extension (v1.0.0) in a hidden, throwaway copy of Google Chrome 153 on the user's Mac. It used the real Jev key and real Jev calls (`jev-latest`, which answered as `jev-1.13.0`), and the real AI bridge.
- **Page:** the pinned test page, [Artificial intelligence, revision 1376335904](https://en.wikipedia.org/w/index.php?title=Artificial_intelligence&oldid=1376335904). It came out at 241 chunks, read in 39 ms when the box opened.
- **Method:** the box was opened with the same code the shortcut runs. Each question was typed and Enter was pressed, all 10 in order on one page load. Only the first result counts.
- **Timing:** the time is measured by the box itself, from the Enter key press until the highlight is on and the page has scrolled.

## The 10 questions

The sentence highlight, the sources, and the AI answer come a moment after the paragraph jump, and don't count toward the time.

| # | Question | Box said | Jumped to (paragraph opening) | Sentence highlighted | Hit |
| - | -------- | -------- | ----------------------------- | -------------------- | --- |
| 1 | when did a computer first beat the world chess champion | 1 of 1 · 99% · 325 ms | "Game playing programs have been used since the 1950s…" | "Deep Blue became the first computer chess-playing system to beat a reigning world chess champion, Garry Kasparov, on 11 May 1997." | ✓ |
| 2 | how much more electricity does a chatgpt question use than a google search | 1 of 1 · 99% · 385 ms | "Power consumption by AI is responsible for an increase in fossil fuel use…" | "A ChatGPT search involves 10 times as much electrical energy as a Google search." | ✓ |
| 3 | have lawyers gotten in trouble for using AI that made up fake cases | 1 of 1 · 99% · 240 ms | "The use of generative AI by law firms for legal research…" | "By 2026, judges had issued sanctions and bar associations had issued warnings due to attorney submissions to the courts containing fabricated case law citations hallucinated by AI tools." | ✓ |
| 4 | can an algorithm be racist even if it's never told anyone's race | 1 of 2 · 99% · 295 ms | "A program can make biased decisions even if the data does not explicitly mention…" | "A program can make biased decisions even if the data does not explicitly mention a problematic feature (such as "race" or "gender")." | ✓ |
| 5 | when did AI start as a field | 1 of 2 · 99% · 351 ms | "Artificial intelligence was founded as an academic discipline in 1956…" | "Artificial intelligence was founded as an academic discipline in 1956." | ✓ |
| 6 | what's the difference between supervised and unsupervised learning | 1 of 1 · 99% · 378 ms | "In supervised learning, the training data is labelled with the expected answers…" | "In supervised learning, the training data is labelled with the expected answers, while in unsupervised learning, the model identifies patterns or structures in unlabelled data." | ✓ |
| 7 | what's the movie with the killer computer on a spaceship | 1 of 1 · 97% · 446 ms | "A common trope in these works began with Mary Shelley's Frankenstein…" | "…Clarke's and Stanley Kubrick's 2001: A Space Odyssey (both 1968), with HAL 9000, the murderous computer in charge of the Discovery One spaceship…" | ✓ |
| 8 | are tech companies really reopening old nuclear plants for AI | 1 of 2 · 96% · 215 ms | "In September 2024, Microsoft announced an agreement with Constellation Energy…" | "In September 2024, Microsoft announced an agreement with Constellation Energy to re-open the Three Mile Island nuclear power plant…" | ✓ |
| 9 | how much does chatgpt cost per month | Not found on this page · 2% · 421 ms | nothing (correct: the page doesn't say) | none | ✓ |
| 10 | how do i cancel my netflix subscription | Not found on this page · 2% · 367 ms | nothing (correct) | none | ✓ |

When there was more than one match, as in questions 4, 5 and 8, the ↓ key moved to the other accepted paragraph.

## Sources and AI answers from the same run

| # | Sources listed (the citation behind the sentence) | AI answer (all by agy, Gemini Flash) |
| - | ------------------------------------------------- | ------------------------------------ |
| 1 | [147] Anderson, M. R. (2017). "Twenty years on from Deep Blue vs Kasparov…" The Conversation | "Deep Blue became the first computer chess-playing system to beat a reigning world chess champion, Garry Kasparov, on 11 May 1997." (4.5 s) |
| 2 | [231] Halper & O'Donovan (2024). "AI is exhausting the power grid…" | "A ChatGPT search involves 10 times as much electrical energy as a Google search." (4.1 s) |
| 3 | [201] Lichtenberg, N. "Even as hallucinations show up in legal filings…" | "Yes, by 2026, judges had issued sanctions and bar associations had issued warnings…" (4.3 s) |
| 4 | [265] Russell & Norvig (2021, p. 995); Lipartito (2011, p. 36); … | "Yes, a program can make biased decisions even if data does not explicitly mention race…" (8.3 s) |
| 5 | [4] Dartmouth workshop: Russell & Norvig (2021, p. 18), McCorduck (2004)… | "Artificial intelligence was founded as an academic discipline in 1956…" (4.4 s) |
| 6 | none: that sentence cites nothing | "In supervised learning, the training data is labelled with the expected answers…" (3.8 s) |
| 7 | [460] Buttazzo (2001), followed through to the full entry: "Artificial consciousness: Utopia or real possibility?" Computer 34 (7) | "The movie is Stanley Kubrick's 2001: A Space Odyssey (1968). It features HAL 9000…" (4.2 s) |
| 8 | [235] Halper, E. (2024). "Microsoft deal would reopen Three Mile Island nuclear plant…" | "Yes, in September 2024, Microsoft announced an agreement with Constellation Energy to re-open the Three Mile Island nuclear power plant…" (3.7 s) |
| 9 | none | "This page doesn't say. Generally, ChatGPT offers a free tier as well as a ChatGPT Plus subscription that costs $20 per month." (4.6 s) |
| 10 | none | "This page doesn't say. Generally, you can cancel your Netflix subscription by logging into your account…" (4.8 s) |

## The other features, same run

| Check | Result |
| ----- | ------ |
| Word for word: "Kasparov" | "Word for word · 2 places", both highlighted. Shift+↓ stepped to "2 of 2". |
| Compare mode (Option+Enter) on question 1 | Jev 306 ms vs agy 8,201 ms. Both picked the same paragraph, and Jev was 26.8× faster. No Claude key was saved, so the second model was agy and the box said so. |
| Settings page | "A Jev key is saved." · Check AI tools: "Bridge ready. agy ✓ grok ✓ codex ✓" |
| Esc | Closed the box and removed every highlight. |
| Extension ID | The formula `setup.sh` uses matched the ID Chrome gave the unpacked folder. |
| AI bridge on its own | agy, grok, and codex each answered through the bridge when Chrome-style started it with a bare environment: 4.1 s, 3.5 s, and 5.3 s. |

## What wasn't tested here

- **The user's own Chrome and the real keyboard shortcut.** The shortcut itself was confirmed by the user on 2026-09-23. To run this test yourself, reload the extension, open the test page, and ask the 10 questions from the table.
- **Claude Haiku in compare mode** was never run, and was removed in 1.4.1.
- **Pages other than Wikipedia,** like terms of service and help pages. The "Not found" cutoff (50%) was tuned on this page.
- **The hosted AI provider against a real endpoint** (added 2026-10-19). `provider-check.mjs` covers its logic against a stubbed `fetch`, but no real request has been sent to a real API with a real key. The first run on a real key is still unproven: the endpoint path, the request body and the reply shape are standard OpenAI chat-completions, but standard is not the same as checked.
- **The settings page in a browser** since the provider picker and hosted key card were added. The ids and radio groups `options.js` reaches for were checked against `options.html` statically, not by loading the page.

## Other checks

- **`node tests/provider-check.mjs`** covers the AI provider seam and the shared HTTP layer in `net.js`: every HTTP status mapped to its error code, for Jev and the hosted AI alike; retries and backoff; the hosted key coming from config and never from the source; the local bridge; the fallback from local to hosted when the helper isn't installed; and the free plan refusing before anything leaves the computer. It needs no browser, no key, and no network, so it runs anywhere Node does, and costs nothing.

  **Run on 2026-10-19, by Claude: all passed, 89 checks.** This is the only harness that can run outside a Mac with Chrome.

- **`node tests/scorer-check.mjs`** runs the Jev scorer from Node on the saved chunks. It covers the 10 questions, a padded page that forces the page to split into several calls, and every error case, like a bad key, Jev being busy, being offline, or a timeout. It costs about $0.02.
- **`CTRLF_TMP=<folder> node tests/chrome-check.mjs`** is the run above. It costs about $0.013 of Jev. Use `--questions 1,9` to run a few questions, and `--no-ai` or `--no-extras` to skip parts.
- **`tests/searchbox-test.html`** opens the real box with fake answers, for checking layout and messages without Jev.

## Spending

All test calls are logged in [`.scratch/ctrl-f-by-meaning/spend.md`](.scratch/ctrl-f-by-meaning/spend.md). The total is $0.19 of the $1 test budget.
