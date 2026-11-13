Pareto for Chrome, version __VERSION__
Ctrl+F by meaning, from Pareto Labs.

Install
1. Move this folder somewhere it can stay, like your Documents folder. Chrome loads the
   extension from here, so keep the folder.
2. In Chrome, go to chrome://extensions
3. Turn on Developer mode, at the top right.
4. Click Load unpacked and choose this folder.
5. Click the puzzle piece in Chrome's toolbar, then the pin next to Pareto.

Had Ctrl+F by meaning before? That was this extension's old name. Remove the old one
on chrome://extensions, then load this folder. You'll need to paste your keys again.

Use it
On any website, press Control+Shift+F (the Control key, not Command), or click its icon.
Type a word and it lights up on the page, like normal Ctrl+F.

Search by meaning (AI plan)
You need a Nebius key (for NVIDIA Nemotron), a Jev key, or both. With only a Nebius key,
everything works. Adding a Jev key makes finding the answer faster.

Nebius key, for NVIDIA Nemotron
1. Right-click the extension's icon and choose Options.
2. Under Plan, choose AI plan.
3. Go to tokenfactory.nebius.com, sign in or make an account, and create an API key.
   Copy it.
4. Paste it under "Nebius key, for NVIDIA Nemotron" and click Save.
5. Click Check the key. It should end with Lightning ✓ Super ✓ Ultra ✓.
6. Recommended: in your Nebius account profile, switch on Zero Data Retention, so Nebius
   doesn't keep what Pareto sends it.

Jev key (optional, the fastest way to find the answer)
1. Go to console.typesafe.ai, sign in or make an account, click API Keys, then
   + Create key. Type a name, like pareto, and click Create key.
2. Copy the key (it starts with apikey_), paste it under Jev key, and click Save.

Keys
Enter          find the sentence that answers your question, with a short answer
               from Nemotron 3 Super
Command+Enter  think harder (Ctrl+Enter on Windows): Nemotron 3 Ultra reads the whole
               page, answers, and highlights the parts it used
Option+Enter   compare mode: Jev against Nemotron 3.5 Lightning

Written answers
Under AI answers, Nemotron 3 Super is already chosen. To use another AI service instead,
choose Hosted AI, paste its key under Hosted AI key, and put its address under
"Endpoint and model" if it isn't OpenAI. Prefer no written answers? Choose Off: finding
the sentence on the page doesn't need them.

All keys are kept in this browser, on this computer. They're never shown again once
saved, and web pages can't read them.

Costs
Jev and Nebius both charge by use. A question about a long page costs about a tenth of a
cent with Jev or Nemotron Lightning. Thinking harder with Nemotron 3 Ultra costs a few cents.
