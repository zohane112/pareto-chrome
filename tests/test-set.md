# Test set

This is the one test that the Jev prototype ([Find the way of asking Jev that gets 8 of 10 right in under a second](../.scratch/ctrl-f-by-meaning/issues/07-prototype-jev-scoring.md)) and the final `TESTS.md` both run. Don't change it between those two runs. If a question needs changing, change it here first and note the date.

Picked by Claude on 2026-09-23. The user said to finish this step without asking, so the questions are Claude's wording, not the user's. Swap any of them before the prototype runs if you'd phrase it differently.

## The page

**Artificial intelligence** on English Wikipedia, pinned to one saved version so the paragraphs can't change under the test:

https://en.wikipedia.org/w/index.php?title=Artificial_intelligence&oldid=1376335904

- It's revision 1376335904. Wikipedia shows a grey "This is an old revision of this page" banner at the top. That's expected. Test on this link, not the live article.
- It has 184 paragraphs, 18 list items in the article body, and 77 headings.
- Of the 31 long articles we measured, including World War II, United States, and Winston Churchill, only "Russian invasion of Ukraine" had more paragraphs (190). We passed on it because it's a war page that keeps changing, and AI is closer to what the user works on. No article we checked came near 255 paragraphs or 24,000 words of prose, because Wikipedia keeps articles shorter than that.
- At the end are 34 "See also" links and 172 references. The body is about 15,000 words, or about 20,000 with the references.
- **Why this counts as the hard case:** it goes over Jev's 255-options-per-question limit unless the chunker both folds headings into their paragraphs and skips the end lists. In that one setup it's about 202 chunks.
- **Update, 2026-09-23:** the real chunker ([Build the page reader and chunker](../.scratch/ctrl-f-by-meaning/issues/06-page-reader-chunker.md)) does fold headings in and skips reference lists. It keeps figure captions and "See also" descriptions, and comes out at **241 chunks** (about 18k tokens). That's under 255 and under 32k tokens, so this page fits in one Jev call. The chunks are saved in `tests/ai-chunks.json`.
- The article is written in British spelling ("optimisation", "labelling").

## What counts as a hit

- **Questions with an answer:** it's a hit when the paragraph the search box jumps to and highlights is one of the accepted paragraphs listed for that question. If the chunker splits a long paragraph into pieces, landing on any piece of an accepted paragraph counts. Landing anywhere else is a miss, and so is showing "Not found".
- **Questions with no answer:** it's a hit when the box says the page doesn't answer it ("Not found on this page") and doesn't jump. Jumping to any paragraph is a miss.
- **Only the first result counts.** Results further down the list don't turn a miss into a hit. They're still worth writing down, because they help with tuning.
- **Goal:** at least 8 hits out of 10.

## What "usually under 1 second" means

- Time each question from pressing Enter to the highlight (or the "Not found" message) appearing on screen.
- Load the page once, then run the 10 questions in order without reloading. The first question pays for reading and chunking the page, and that's part of the real experience, so it counts too.
- **Goal:** the median of the 10 times is under 1,000 ms. Write down the slowest time too, but it doesn't pass or fail the test.

## The 10 questions

Each accepted paragraph is written as its opening words, which is enough to find it with the browser's normal Ctrl+F.

| # | Question | Accepted paragraph(s) | Section | Why it's in the test |
| - | -------- | --------------------- | ------- | -------------------- |
| 1 | when did a computer first beat the world chess champion | "Game playing programs have been used since the 1950s…" | Applications > Gaming | Easy. It shares words with the answer ("chess", "champion"), so it's a baseline. |
| 2 | how much more electricity does a chatgpt question use than a google search | "Power consumption by AI is responsible for an increase in fossil fuel use…" | Ethics > Power needs and environmental impacts | Hard. It sits among 12 paragraphs about AI and power. The answer is one sentence: "10 times". |
| 3 | have lawyers gotten in trouble for using AI that made up fake cases | "The use of generative AI by law firms for legal research…" | Applications > Other industry-specific tasks | Paraphrase. The page says "fabricated case law citations", not "fake cases". |
| 4 | can an algorithm be racist even if it's never told anyone's race | "A program can make biased decisions even if the data does not explicitly mention…" **or** "COMPAS is a commercial program widely used by U.S. courts…" | Ethics > Algorithmic bias and fairness | Two right answers. One paragraph gives the general point, the other a real case. |
| 5 | when did AI start as a field | "The field of AI research was founded at a workshop at Dartmouth College…" **or** "Artificial intelligence was founded as an academic discipline in 1956…" | History, or the intro | Easy, with two right answers: the intro and the History section both say 1956. |
| 6 | what's the difference between supervised and unsupervised learning | "Supervised learning requires labelling the training data…" **or** "Unsupervised learning analyses a stream of data…" **or** the image caption "In supervised learning, the training data is labelled with the expected answers, while in unsupervised learning…" | Goals > Learning | The answers are list items, not paragraphs. The answer is split across two bullets, so either one counts. The caption was added on 2026-09-23 (see Changes). |
| 7 | what's the movie with the killer computer on a spaceship | "A common trope in these works began with Mary Shelley…" | In fiction | Hard paraphrase. The page says "the murderous computer in charge of the Discovery One spaceship" and never says "killer". This one is at the very end of the article. |
| 8 | are tech companies really reopening old nuclear plants for AI | "In September 2024, Microsoft announced an agreement with Constellation Energy…" **or** "In 2024, The Wall Street Journal reported that big AI companies have begun negotiations…" | Ethics > Power needs and environmental impacts | Hard. Several paragraphs nearby are about nuclear power and data centres. Two of them actually answer it. |
| 9 | how much does chatgpt cost per month | none. Should say "Not found" | — | **No answer.** ChatGPT is named many times, but the page never gives a price or mentions a subscription. It tests whether the cutoff can say "not here" when the topic is close. |
| 10 | how do i cancel my netflix subscription | none. Should say "Not found" | — | **No answer.** Netflix is named once, in a list of recommendation systems. This is a help-page style question, like the pages the user really wants this for. |

## Checked

- On 2026-09-23, the pinned page was opened in Claude's browser. Each accepted paragraph's opening words matched exactly one paragraph or list item on it.
- A text search of the whole page, references included, found no mention of a subscription, a monthly price, "$20", or cancelling. That confirms questions 9 and 10 have no answer.
- The DOM holds 2,380 `li` elements in total, but only 18 are in the article body. The rest are navboxes and references. The chunker must skip navboxes, or the count explodes.

## Changes

- **2026-09-23, question 6:** added the image caption "In supervised learning, the training data is labelled with the expected answers, while in unsupervised learning…" as a third accepted answer.
  - When the test was written, the page was read with a script that looked only at paragraphs and list items, so it never saw the image captions. The real chunker keeps captions.
  - In the first prototype run, Jev picked this caption, and it states the difference in one sentence. That's a better answer than either bullet.
  - This change came after seeing that result. [Find the way of asking Jev that gets 8 of 10 right in under a second](../.scratch/ctrl-f-by-meaning/issues/07-prototype-jev-scoring.md) reports scores both before and after it.
